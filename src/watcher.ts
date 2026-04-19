import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config";
import type { KnowledgeIndex } from "./index-store";

/**
 * Watches configured directories for file changes and updates the index in real-time.
 * Uses Node.js fs.watch (recursive) with debouncing.
 */
export class FileWatcher {
  private config: Config;
  private index: KnowledgeIndex;
  private watchers: fs.FSWatcher[] = [];
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private DEBOUNCE_MS = 300;

  constructor(config: Config, index: KnowledgeIndex) {
    this.config = config;
    this.index = index;
  }

  start(): void {
    for (const dir of this.config.dirs) {
      try {
        const watcher = fs.watch(
          dir,
          { recursive: true },
          (eventType, filename) => {
            if (!filename) return;
            const relPath = filename.replace(/\\/g, "/");

            // Check file extension
            const ext = path.extname(relPath);
            if (!this.config.fileExtensions.includes(ext)) return;

            // Skip excluded directories and dotfiles
            const parts = relPath.split("/");
            for (const part of parts) {
              if (this.config.excludeDirs.includes(part) || part.startsWith(".")) {
                return;
              }
            }

            const absPath = path.join(dir, relPath);
            this.debounce(absPath, dir);
          }
        );
        // Handle watcher errors gracefully — transient files (e.g. sed -i
        // temp files) can cause EACCES when the watcher tries to observe a
        // file that's already been deleted.
        watcher.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EACCES" || err.code === "ENOENT") {
            // Transient file — ignore silently
            return;
          }
          console.error(
            `knowledge-search: watcher error for ${dir}: ${err.message}`
          );
        });
        this.watchers.push(watcher);
      } catch (err: any) {
        console.error(
          `knowledge-search: watcher failed for ${dir}: ${err.message}`
        );
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  private debounce(absPath: string, sourceDir: string): void {
    const existing = this.pending.get(absPath);
    if (existing) clearTimeout(existing);

    this.pending.set(
      absPath,
      setTimeout(async () => {
        this.pending.delete(absPath);
        try {
          if (fs.existsSync(absPath)) {
            await this.index.updateFile(absPath, sourceDir);
          } else {
            this.index.removeFile(absPath);
          }
        } catch (err: any) {
          console.error(
            `knowledge-search: watcher update failed for ${absPath}: ${err.message}`
          );
        }
      }, this.DEBOUNCE_MS)
    );
  }
}
