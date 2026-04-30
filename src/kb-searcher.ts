import type { SearchResult } from "./index-store.js";

export interface KnowledgeBaseConfig {
  /** Bedrock Knowledge Base ID */
  id: string;
  /** AWS region (default: us-east-1) */
  region?: string;
  /** AWS profile (default: "default") */
  profile?: string;
  /** Human-readable label for display */
  label?: string;
}

/**
 * Searches one or more Bedrock Knowledge Bases and returns results
 * normalized to the same SearchResult shape as local index results.
 */
export class BedrockKBSearcher {
  private configs: KnowledgeBaseConfig[];
  private clients: Map<string, { client: any; config: KnowledgeBaseConfig }> = new Map();
  private initPromise: Promise<void> | null = null;

  constructor(configs: KnowledgeBaseConfig[]) {
    this.configs = configs;
  }

  private async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    try {
      const { BedrockAgentRuntimeClient } = await import("@aws-sdk/client-bedrock-agent-runtime");
      const { fromIni } = await import("@aws-sdk/credential-providers");

      for (const config of this.configs) {
        const region = config.region || "us-east-1";
        const profile = config.profile || "default";
        // Reuse clients for same region+profile
        const cacheKey = `${region}:${profile}`;
        if (!this.clients.has(config.id)) {
          const existing = [...this.clients.values()].find(
            (c) =>
              (c.config.region || "us-east-1") === region &&
              (c.config.profile || "default") === profile
          );
          if (existing) {
            this.clients.set(config.id, {
              client: existing.client,
              config,
            });
          } else {
            const client = new BedrockAgentRuntimeClient({
              region,
              credentials: fromIni({ profile }),
            });
            this.clients.set(config.id, { client, config });
          }
        }
      }
    } catch (err: any) {
      console.error(`knowledge-search: Failed to initialize Bedrock KB client: ${err.message}`);
      this.configs = [];
    }
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    if (this.configs.length === 0) return [];
    await this.init();

    const { RetrieveCommand } = await import("@aws-sdk/client-bedrock-agent-runtime");

    const searches = this.configs.map(async (config) => {
      const entry = this.clients.get(config.id);
      if (!entry) return [];

      try {
        const command = new RetrieveCommand({
          knowledgeBaseId: config.id,
          retrievalQuery: { text: query },
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults: limit,
            },
          },
        });

        const response = await entry.client.send(command, {
          abortSignal: signal,
        });

        const results: SearchResult[] = [];
        for (const result of response.retrievalResults || []) {
          const score = result.score ?? 0;
          // Bedrock scores are 0-1 relevance, same range as our cosine similarity
          if (score < 0.15) continue;

          const uri =
            result.location?.s3Location?.uri ??
            result.location?.webLocation?.url ??
            result.location?.confluenceLocation?.url ??
            result.location?.salesforceLocation?.url ??
            result.location?.sharePointLocation?.url ??
            "unknown";

          const label = config.label ? ` [${config.label}]` : " [KB]";

          results.push({
            path: `${uri}${label}`,
            score,
            excerpt: result.content?.text || "",
            heading: "",
          });
        }
        return results;
      } catch (err: any) {
        console.error(`knowledge-search: KB ${config.id} search failed: ${err.message}`);
        return [];
      }
    });

    const allResults = (await Promise.all(searches)).flat();
    return allResults.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
