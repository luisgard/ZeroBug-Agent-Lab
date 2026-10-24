import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveInstructions } from "../src/util/instructions.ts";

const tmpFile = (text: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "zb-instr-")), "agent.txt");
  writeFileSync(p, text, "utf8");
  return p;
};

describe("resolveInstructions", () => {
  test("reads multi-line instructions from a file unchanged", () => {
    const text = "You are a shopping assistant.\n- Rule one.\n- Rule two.\n";
    expect(resolveInstructions({ file: tmpFile(text) })).toBe(text.trim());
  });

  test("accepts inline instructions", () => {
    expect(resolveInstructions({ instructions: "  Be helpful.  " })).toBe("Be helpful.");
  });

  test("rejects both inline and file", () => {
    expect(() => resolveInstructions({ instructions: "a", file: tmpFile("b") })).toThrow(
      "Use either --instructions or --instructions-file, not both",
    );
  });

  test("rejects a missing file with its path", () => {
    expect(() => resolveInstructions({ file: "no/such/agent.txt" })).toThrow("Cannot read instructions file: no/such/agent.txt");
  });

  test("rejects empty instructions", () => {
    expect(() => resolveInstructions({ file: tmpFile("   \n") })).toThrow("Agent instructions must not be empty");
    expect(() => resolveInstructions({})).toThrow("Agent instructions must not be empty");
  });
});
