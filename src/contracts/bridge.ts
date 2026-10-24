/**
 * HTTP bridge protocol v1 (see docs/HTTP-BRIDGE-CONTRACT.md). Strict schemas on both directions.
 */
import { z } from "zod";
import { AgentCapabilitiesSchema } from "./index.ts";

export const BRIDGE_PROTOCOL_VERSION = "1";

const ToolDefSchema = z.strictObject({
  type: z.literal("function"),
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  description: z.string().max(1000).optional(),
  parameters: z.record(z.string(), z.unknown()),
});

export const BridgeRunRequestSchema = z.strictObject({
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  runId: z.string().uuid(),
  task: z.string().min(1).max(4000),
  toolsUrl: z.string().url(),
  toolsToken: z.string().min(32).max(200),
  tools: z.array(ToolDefSchema).max(64),
  limits: z.strictObject({ maxToolCalls: z.number().int().min(1).max(1000), maxSeconds: z.number().int().min(1).max(3600) }),
});
export type BridgeRunRequest = z.infer<typeof BridgeRunRequestSchema>;

export const BridgeRunResponseSchema = z.strictObject({
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  runId: z.string().uuid(),
  finalMessage: z.string().max(20_000).nullable(),
});
export type BridgeRunResponse = z.infer<typeof BridgeRunResponseSchema>;

export const ToolCallResponseSchema = z.union([
  z.strictObject({ success: z.literal(true), output: z.unknown() }),
  z.strictObject({ success: z.literal(false), error: z.string() }),
]);

/** Optional handshake: `GET /agent/capabilities`. Everything here is DECLARED until a smoke run verifies it. */
export const BridgeCapabilitiesSchema = z.strictObject({
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  agent: z.strictObject({ name: z.string().max(100), version: z.string().max(50), framework: z.string().max(100) }),
  capabilities: AgentCapabilitiesSchema.partial(),
});
export type BridgeCapabilities = z.infer<typeof BridgeCapabilitiesSchema>;
