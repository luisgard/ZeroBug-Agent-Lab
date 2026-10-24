/**
 * Starts and stops the independent example processes (Python agent, staging outbox).
 * ZeroBug talks to them only over HTTP; nothing is imported from the agent.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { redactText } from "../../src/util/redact.ts";

export const AGENT_DIR = resolve("examples/external-agent");
const PY = process.platform === "win32" ? join(AGENT_DIR, ".venv", "Scripts", "python.exe") : join(AGENT_DIR, ".venv", "bin", "python");

export type Managed = { name: string; proc: ChildProcess; url: string; stop: () => Promise<number | null> };

export function pythonAvailable(): boolean {
  return existsSync(PY);
}

export async function startPython(o: {
  name: string;
  module: string;
  args: string[];
  port: number;
  healthPath: string;
  env?: Record<string, string>;
  logFile: string;
  secrets?: string[];
}): Promise<Managed> {
  if (!pythonAvailable()) throw new Error(`Python venv missing at ${PY}. See docs/EXTERNAL-AGENT-DEMO.md`);
  mkdirSync(dirname(o.logFile), { recursive: true });
  const log = createWriteStream(o.logFile, { flags: "a" });
  const proc = spawn(PY, ["-m", o.module, ...o.args], {
    cwd: AGENT_DIR,
    env: { PATH: process.env.PATH ?? "", PYTHONUNBUFFERED: "1", ...o.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const write = (b: Buffer) => log.write(redactText(b.toString(), o.secrets ?? []));
  proc.stdout!.on("data", write);
  proc.stderr!.on("data", write);
  const url = `http://127.0.0.1:${o.port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`${o.name} exited early with code ${proc.exitCode}; see ${o.logFile}`);
    try {
      const res = await fetch(`${url}${o.healthPath}`, { signal: AbortSignal.timeout(1000) });
      if (res.status < 500) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error(`${o.name} did not become healthy on ${url}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const stop = () =>
    new Promise<number | null>((resolveStop) => {
      if (proc.exitCode !== null) return resolveStop(proc.exitCode);
      const t = setTimeout(() => proc.kill("SIGKILL"), 5000);
      proc.once("exit", (code) => {
        clearTimeout(t);
        log.end();
        resolveStop(code);
      });
      proc.kill("SIGTERM");
    });
  return { name: o.name, proc, url, stop };
}
