import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "./run-scenario.ts";
import { redactValue } from "../util/redact.ts";

/** Saved runs as JSON files. Recorded runs are never edited after saving. */
export class RunStore {
  constructor(
    readonly writeDir = process.env.ZB_DATA_DIR ?? "data/runs",
    private readonly readDirs: string[] = [writeDir, "data/recorded"],
  ) {}

  async save(r: RunRecord, extraSecrets: string[] = []): Promise<string> {
    await mkdir(this.writeDir, { recursive: true });
    const file = join(this.writeDir, `${r.runId}.json`);
    await writeFile(file, JSON.stringify(redactValue(r, extraSecrets), null, 2), { flag: "wx" });
    return file;
  }

  async get(runId: string): Promise<RunRecord | null> {
    if (!/^[0-9a-f-]{36}$/.test(runId)) return null;
    for (const d of this.readDirs) {
      try {
        return JSON.parse(await readFile(join(d, `${runId}.json`), "utf8"));
      } catch {
        /* try next */
      }
    }
    return null;
  }

  async list(dir = this.writeDir): Promise<RunRecord[]> {
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
      return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as RunRecord));
    } catch {
      return [];
    }
  }
}
