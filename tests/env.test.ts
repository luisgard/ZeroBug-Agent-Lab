import { describe, expect, test } from "vitest";
import { parseEnvFile } from "../src/util/env.ts";

describe(".env.local as Windows editors save it", () => {
  const text = "# comentario\r\nOPENAI_API_KEY=sk-test-1\r\nexport ZB_PLANNER=rules\r\nQUOTED=\"a b\"\r\nEMPTY=\r\n";
  for (const [name, buf] of [
    ["UTF-8", Buffer.from(text)],
    ["UTF-8 with BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])],
    ["UTF-16 LE (PowerShell 5 redirection)", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])],
  ] as const) {
    test(name, () => {
      expect(parseEnvFile(buf)).toEqual({ OPENAI_API_KEY: "sk-test-1", ZB_PLANNER: "rules", QUOTED: "a b", EMPTY: "" });
    });
  }
});
