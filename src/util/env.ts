import { existsSync, readFileSync } from "node:fs";

/**
 * Parses a .env file the way Windows editors may save it: UTF-8 with or without BOM, UTF-16 (LE/BE),
 * CRLF line ends, optional quotes and `export`. Values are never printed.
 */
export function parseEnvFile(buf: Buffer): Record<string, string> {
  let text: string;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString("utf16le");
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  else text = buf.toString("utf8");
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, "").replace(/\u0000/g, "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trimStart().startsWith("#")) continue;
    let v = m[2]!;
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

/** Loads server-side secrets from .env.local when present. Never exposed to the browser or agents. */
export function loadLocalEnv(file = ".env.local"): void {
  if (!existsSync(file)) return;
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(file)))) if (v !== "" && !process.env[k]) process.env[k] = v;
}
