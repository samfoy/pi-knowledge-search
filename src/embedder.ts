import type { ProviderConfig } from "./config";

/**
 * Unified embedding interface. Implementations for OpenAI, OpenAI-compatible,
 * Bedrock, and Ollama.
 */
export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(
    texts: string[],
    signal?: AbortSignal,
    concurrency?: number
  ): Promise<(number[] | null)[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmbedder(config: ProviderConfig, dimensions: number): Embedder {
  switch (config.type) {
    case "openai":
      return new OpenAIEmbedder(config.apiKey, config.model, dimensions, undefined);
    case "openai-compatible":
      return new OpenAIEmbedder(config.apiKey ?? "", config.model, dimensions, config.baseUrl);
    case "bedrock":
      return new BedrockEmbedder(config.profile, config.region, config.model, dimensions);
    case "ollama":
      return new OllamaEmbedder(config.url, config.model);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Truncate to stay within token limits. Conservative: ~10K chars ≈ 4-6K tokens. */
function truncate(text: string, maxChars = 10000): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff for 429s

/** Retry a fetch-based operation on 429 rate-limit errors with exponential backoff. */
async function withRateLimitRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const is429 =
        err?.message?.includes("429") ||
        err?.name === "ThrottlingException" ||
        err?.$metadata?.httpStatusCode === 429;
      if (is429 && attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        console.error(
          `knowledge-search: ${label} rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

/** Run an async function over an array with bounded concurrency. */
async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new Error("Aborted");
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// OpenAI / OpenAI-compatible
// ---------------------------------------------------------------------------

class OpenAIEmbedder implements Embedder {
  private apiKey: string;
  private model: string;
  private dimensions: number;
  private endpoint: string;

  constructor(apiKey: string, model: string, dimensions: number, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    if (baseUrl) {
      this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
    } else {
      this.endpoint = `https://api.openai.com/v1/embeddings`;
    }
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const results = await this.embedBatch([text], signal);
    if (!results[0]) throw new Error("Embedding failed — provider returned no vector");
    return results[0];
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<(number[] | null)[]> {
    // OpenAI supports batch embedding natively (up to 2048 inputs).
    // Chunk into groups of 100 to stay safe on payload size.
    const BATCH = 100;
    const results: (number[] | null)[] = new Array(texts.length);

    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error("Aborted");
      const batch = texts.slice(i, i + BATCH).map((t) => truncate(t));

      try {
        const json = await withRateLimitRetry(async () => {
          const res = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              input: batch,
              model: this.model,
              dimensions: this.dimensions,
            }),
            signal,
          });

          if (!res.ok) {
            const body = await res.text();
            throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 200)}`);
          }

          return (await res.json()) as {
            data: { embedding: number[]; index: number }[];
          };
        }, "embedding");

        for (const item of json.data) {
          results[i + item.index] = item.embedding;
        }
      } catch (err: any) {
        // Mark the whole batch as failed
        for (let j = 0; j < batch.length; j++) {
          results[i + j] = null;
        }
        const label = this.endpoint.includes("api.openai.com")
          ? "OpenAI"
          : `Embedding (${this.endpoint})`;
        console.error(`${label} batch embedding failed: ${err.message}`);
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Bedrock (Titan)
// ---------------------------------------------------------------------------

class BedrockEmbedder implements Embedder {
  private client: any; // Lazy-loaded to avoid hard dep if not using Bedrock
  private model: string;
  private dimensions: number;
  private clientPromise: Promise<any>;

  constructor(profile: string, region: string, model: string, dimensions: number) {
    this.model = model;
    this.dimensions = dimensions;

    // Lazy-load the AWS SDK — it's an optional dependency
    this.clientPromise = (async () => {
      const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
      const { fromIni } = await import("@aws-sdk/credential-providers");
      return new BedrockRuntimeClient({
        region,
        credentials: fromIni({ profile }),
      });
    })();
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const results = await this.embedBatch([text], signal);
    if (!results[0]) throw new Error("Embedding failed — provider returned no vector");
    return results[0];
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal,
    concurrency = 10
  ): Promise<(number[] | null)[]> {
    const client = await this.clientPromise;

    return parallelMap(
      texts,
      async (text) => {
        try {
          return await this.callBedrock(client, text);
        } catch (err: any) {
          console.error(`Bedrock embedding failed (${text.slice(0, 50)}...): ${err.message}`);
          return null;
        }
      },
      concurrency,
      signal
    );
  }

  private async callBedrock(client: any, text: string): Promise<number[]> {
    return withRateLimitRetry(async () => {
      const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");

      const body = JSON.stringify({
        inputText: truncate(text),
        dimensions: this.dimensions,
        normalize: true,
      });

      const command = new InvokeModelCommand({
        modelId: this.model,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(body),
      });

      const response = await client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      if (!responseBody.embedding) {
        throw new Error(
          "Unexpected Bedrock response: " + JSON.stringify(responseBody).slice(0, 200)
        );
      }
      return responseBody.embedding;
    }, "Bedrock embed");
  }
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

class OllamaEmbedder implements Embedder {
  private url: string;
  private model: string;

  constructor(url: string, model: string) {
    this.url = url.replace(/\/$/, "");
    this.model = model;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    return withRateLimitRetry(async () => {
      const res = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: truncate(text) }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama API ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = (await res.json()) as { embeddings: number[][] };
      return json.embeddings[0];
    }, "Ollama embed");
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal,
    concurrency = 4
  ): Promise<(number[] | null)[]> {
    // Ollama /api/embed supports batch via `input` array
    // but some models/versions don't. Fall back to parallel single calls.
    return parallelMap(
      texts,
      async (text) => {
        try {
          return await this.embed(text, signal);
        } catch (err: any) {
          console.error(`Ollama embedding failed (${text.slice(0, 50)}...): ${err.message}`);
          return null;
        }
      },
      concurrency,
      signal
    );
  }
}
