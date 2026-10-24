import { readFileSync } from "node:fs";

/**
 * Agent instructions from --instructions or --instructions-file. The file form exists because
 * Windows `npx`/`npm run` cut command-line arguments at the first line break.
 */
export function resolveInstructions(opts: { instructions?: string | undefined; file?: string | undefined }): string {
  if (opts.instructions !== undefined && opts.file !== undefined) {
    throw new Error("Use either --instructions or --instructions-file, not both");
  }
  let text = opts.instructions ?? "";
  if (opts.file !== undefined) {
    try {
      text = readFileSync(opts.file, "utf8");
    } catch {
      throw new Error(`Cannot read instructions file: ${opts.file}`);
    }
  }
  text = text.trim();
  if (!text) throw new Error("Agent instructions must not be empty");
  return text;
}
