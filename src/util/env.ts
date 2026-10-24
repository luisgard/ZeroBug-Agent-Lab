import { existsSync } from "node:fs";

/** Loads server-side secrets from .env.local when present. Never exposed to the browser or agents. */
export function loadLocalEnv(file = ".env.local"): void {
  if (existsSync(file)) process.loadEnvFile(file);
}
