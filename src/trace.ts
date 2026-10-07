import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface EventSink {
  record(event: Record<string, unknown>): Promise<void>;
}

export class RunTrace implements EventSink {
  private constructor(readonly directory: string, private readonly writer: ReturnType<Bun.BunFile["writer"]>) {}

  static async create(root: string, id: string): Promise<RunTrace> {
    const directory = join(root, ".bitzen", "runs", id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "events.jsonl");
    await Bun.write(path, "");
    await chmod(path, 0o600);
    return new RunTrace(directory, Bun.file(path).writer());
  }

  async record(event: Record<string, unknown>): Promise<void> {
    this.writer.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
    await this.writer.flush();
  }

  async save(name: "sessions.json" | "summary.json", value: unknown): Promise<void> {
    const path = join(this.directory, name);
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
    await chmod(path, 0o600);
  }

  async close(): Promise<void> {
    await this.writer.end();
  }
}
