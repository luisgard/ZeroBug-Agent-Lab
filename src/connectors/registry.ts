/**
 * Evidence source configuration (zerobug.sources.json). The file holds only environment variable
 * NAMES for secrets, never secret values, so it can be reviewed and committed safely.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { GmailSource } from "./gmail.ts";
import { HttpJsonSource } from "./http-json.ts";
import { McpSource } from "./mcp.ts";
import { type EvidenceSource, FIELD_PATH, SourceError } from "./types.ts";

const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "environment variable name");
const Fields = z.partialRecord(z.enum(["id", "to", "from", "subject", "body", "date", "product", "quantity", "total", "status", "ref", "amount", "currency"]), z.string().regex(FIELD_PATH));
const HeaderFromEnv = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/), z.strictObject({ env: EnvName, prefix: z.string().max(20).default("") }));
const Kind = z.enum(["email", "order", "payment"]);

const SourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("gmail"),
    clientIdEnv: EnvName,
    clientSecretEnv: EnvName,
    refreshTokenEnv: EnvName,
    userId: z.string().max(320).optional(),
  }),
  z.strictObject({
    kind: z.literal("http_json"),
    headersFromEnv: HeaderFromEnv.default({}),
    healthUrl: z.string().url().optional(),
    queries: z.partialRecord(Kind, z.strictObject({ url: z.string().url(), itemsPath: z.string().regex(FIELD_PATH).optional(), fields: Fields })),
  }),
  z.strictObject({
    kind: z.literal("mcp"),
    transport: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()).default([]), envFromEnv: z.record(EnvName, EnvName).default({}), cwd: z.string().optional() }),
      z.strictObject({ type: z.literal("http"), url: z.string().url(), headersFromEnv: HeaderFromEnv.default({}) }),
    ]),
    allowTools: z.array(z.string().min(1)).min(1),
    healthTool: z.strictObject({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }).optional(),
    queries: z.partialRecord(
      Kind,
      z.strictObject({
        tool: z.string().min(1),
        args: z.record(z.string(), z.unknown()).default({}),
        parse: z.discriminatedUnion("mode", [
          z.strictObject({ mode: z.literal("json"), itemsPath: z.string().regex(FIELD_PATH).optional(), fields: Fields }),
          z.strictObject({ mode: z.literal("text") }),
        ]),
      }),
    ),
  }),
]);

export const SourcesFileSchema = z.strictObject({ sources: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), SourceSchema) });
export type SourcesFile = z.infer<typeof SourcesFileSchema>;

export class SourceRegistry {
  private readonly built = new Map<string, EvidenceSource>();
  constructor(
    private readonly file: SourcesFile,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly overrides: Record<string, EvidenceSource> = {},
  ) {}

  static load(path = process.env.ZB_SOURCES_FILE ?? "zerobug.sources.json", env: NodeJS.ProcessEnv = process.env): SourceRegistry | null {
    if (!existsSync(path)) return null;
    const parsed = SourcesFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new SourceError(`${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return new SourceRegistry(parsed.data, env);
  }

  /** For tests: registry made of ready source objects. */
  static of(sources: Record<string, EvidenceSource>): SourceRegistry {
    return new SourceRegistry({ sources: {} }, {}, sources);
  }

  names(): string[] {
    return [...new Set([...Object.keys(this.file.sources), ...Object.keys(this.overrides)])];
  }

  get(name: string): EvidenceSource {
    if (this.overrides[name]) return this.overrides[name]!;
    const cached = this.built.get(name);
    if (cached) return cached;
    const cfg = this.file.sources[name];
    if (!cfg) throw new SourceError(`Unknown evidence source "${name}" (configure it in zerobug.sources.json)`);
    const secret = (n: string) => {
      const v = this.env[n];
      if (!v) throw new SourceError(`Source "${name}": environment variable ${n} is not set`);
      return v;
    };
    const headers = (h: Record<string, { env: string; prefix: string }>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, `${v.prefix}${secret(v.env)}`]));
    let src: EvidenceSource;
    if (cfg.kind === "gmail") {
      src = new GmailSource({ name, clientId: secret(cfg.clientIdEnv), clientSecret: secret(cfg.clientSecretEnv), refreshToken: secret(cfg.refreshTokenEnv), ...(cfg.userId ? { userId: cfg.userId } : {}) });
    } else if (cfg.kind === "http_json") {
      src = new HttpJsonSource({ name, headers: headers(cfg.headersFromEnv), queries: cfg.queries, ...(cfg.healthUrl ? { healthUrl: cfg.healthUrl } : {}) });
    } else {
      const t = cfg.transport;
      src = new McpSource({
        name,
        allowTools: cfg.allowTools,
        queries: cfg.queries,
        ...(cfg.healthTool ? { healthTool: cfg.healthTool } : {}),
        transport:
          t.type === "stdio"
            ? { type: "stdio", command: t.command, args: t.args, env: Object.fromEntries(Object.entries(t.envFromEnv).map(([k, v]) => [k, secret(v)])), ...(t.cwd ? { cwd: t.cwd } : {}) }
            : { type: "http", url: t.url, headers: headers(t.headersFromEnv) },
      });
    }
    this.built.set(name, src);
    return src;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.built.values(), ...Object.values(this.overrides)].map((s) => s.close?.()));
  }
}
