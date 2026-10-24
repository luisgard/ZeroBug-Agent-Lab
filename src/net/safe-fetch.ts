/**
 * Outbound HTTP to untrusted, user-supplied endpoints.
 *
 * - Only http/https; no userinfo in URLs.
 * - Every hop (initial URL and each redirect) is resolved and every resolved IP is checked.
 * - The connection is pinned to the IP that was checked, so DNS rebinding between check and
 *   connect cannot redirect the request.
 * - Bounded redirects, request size, response size and time.
 * - Private/loopback/link-local/reserved targets are blocked unless local development explicitly
 *   allows private targets; cloud metadata addresses are blocked always.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

export class UnsafeUrlError extends Error {}
export class OutboundError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "connect" | "too_large" | "http" | "protocol",
    readonly status?: number,
  ) {
    super(message);
  }
}

export type NetPolicy = {
  allowPrivate: boolean;
  /** Exact addresses an operator explicitly approved (e.g. one internal staging agent). Metadata stays blocked. */
  allowAddresses?: string[];
};
export type Resolver = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

export const defaultResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family as 4 | 6 }));

/** Reads the policy from the environment. Refuses the private override in public deployments. */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): NetPolicy {
  const allowPrivate = env.ZB_ALLOW_PRIVATE_AGENT_URLS === "1";
  if (allowPrivate && env.ZB_DEPLOYMENT === "public") {
    throw new UnsafeUrlError("ZB_ALLOW_PRIVATE_AGENT_URLS=1 is not allowed when ZB_DEPLOYMENT=public");
  }
  if (allowPrivate && !warned) {
    warned = true;
    console.warn("[zerobug] WARNING: private/loopback agent URLs are allowed (ZB_ALLOW_PRIVATE_AGENT_URLS=1). Local development only.");
  }
  return { allowPrivate };
}
let warned = false;

const always = new BlockList(); // blocked even in local development
always.addAddress("169.254.169.254"); // cloud metadata (AWS/GCP/Azure)
always.addAddress("169.254.170.2"); // ECS task metadata
always.addAddress("100.100.100.200"); // Alibaba metadata
always.addAddress("fd00:ec2::254", "ipv6"); // AWS IMDS IPv6
always.addSubnet("0.0.0.0", 8);
always.addAddress("::", "ipv6");

const privateRanges = new BlockList(); // blocked in hosted mode
for (const [net, bits] of [
  ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) privateRanges.addSubnet(net, bits);
for (const [net, bits] of [
  ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64], ["2001::", 23],
] as const) privateRanges.addSubnet(net, bits, "ipv6");

/** Returns a reason when the address must not be contacted, else null. */
export function blockedReason(ip: string, policy: NetPolicy): string | null {
  const family = isIP(ip);
  if (!family) return `not an IP address: ${ip}`;
  let v4: string | null = null;
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? lower.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) v4 = mapped[1]!;
    else if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) {
      const [hi, lo] = lower.slice(7).split(":").map((h) => parseInt(h, 16));
      v4 = [hi! >> 8, hi! & 255, lo! >> 8, lo! & 255].join(".");
    }
  }
  const [addr, type] = v4 ? [v4, "ipv4" as const] : [ip, family === 4 ? ("ipv4" as const) : ("ipv6" as const)];
  if (always.check(addr, type)) return `blocked address ${ip} (metadata/unspecified)`;
  if (!policy.allowPrivate && privateRanges.check(addr, type) && !policy.allowAddresses?.includes(ip)) {
    return `blocked private/reserved address ${ip}`;
  }
  return null;
}

export type Target = { url: URL; address: string; family: 4 | 6 };

export async function validateUrl(raw: string, policy: NetPolicy, resolve: Resolver = defaultResolver): Promise<Target> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError(`Protocol not allowed: ${url.protocol}`);
  if (url.username || url.password) throw new UnsafeUrlError("Credentials in URLs are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeUrlError("URL has no host");
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : await resolve(host);
  if (addrs.length === 0) throw new UnsafeUrlError(`Host did not resolve: ${host}`);
  for (const a of addrs) {
    const reason = blockedReason(a.address, policy);
    if (reason) throw new UnsafeUrlError(`${host}: ${reason}`);
  }
  return { url, address: addrs[0]!.address, family: addrs[0]!.family };
}

export type SafeFetchOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  policy?: NetPolicy;
  resolve?: Resolver;
  signal?: AbortSignal;
};

export type SafeResponse = { status: number; headers: http.IncomingHttpHeaders; text: string; finalUrl: string; hops: string[] };

export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const policy = opts.policy ?? policyFromEnv();
  const resolve = opts.resolve ?? defaultResolver;
  const maxRedirects = opts.maxRedirects ?? 3;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRequestBytes = opts.maxRequestBytes ?? 256 * 1024;
  if (opts.body && Buffer.byteLength(opts.body) > maxRequestBytes) {
    throw new OutboundError(`Request body exceeds ${maxRequestBytes} bytes`, "too_large");
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let method = opts.method ?? (opts.body ? "POST" : "GET");
  let body = opts.body;
  let current = raw;
  const hops: string[] = [];
  for (let hop = 0; ; hop++) {
    const target = await validateUrl(current, policy, resolve);
    hops.push(target.url.origin + target.url.pathname);
    const res = await requestPinned(target, { method, headers: opts.headers ?? {}, body, signal, maxResponseBytes: opts.maxResponseBytes ?? 1024 * 1024 });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= maxRedirects) throw new OutboundError(`Too many redirects (> ${maxRedirects})`, "protocol");
      current = new URL(res.headers.location, target.url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return { ...res, finalUrl: target.url.toString(), hops };
  }
}

export async function safeFetchJson(raw: string, opts: SafeFetchOptions = {}): Promise<unknown> {
  const res = await safeFetch(raw, opts);
  if (res.status < 200 || res.status >= 300) throw new OutboundError(`HTTP ${res.status}`, "http", res.status);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new OutboundError("Response is not valid JSON", "protocol", res.status);
  }
}

function requestPinned(
  target: Target,
  o: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; maxResponseBytes: number },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const lib = target.url.protocol === "https:" ? https : http;
  return new Promise((resolvePromise, reject) => {
    const req = lib.request(
      target.url,
      {
        method: o.method,
        headers: { ...o.headers, ...(o.body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(o.body)) } : {}) },
        signal: o.signal,
        // Pin the connection to the address that passed validation (defeats DNS rebinding).
        lookup: (_host: string, options: any, cb: any) => {
          if (options?.all) cb(null, [{ address: target.address, family: target.family }]);
          else cb(null, target.address, target.family);
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > o.maxResponseBytes) {
            req.destroy();
            reject(new OutboundError(`Response exceeds ${o.maxResponseBytes} bytes`, "too_large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (err) => reject(new OutboundError(err.message, "connect")));
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (o.signal.aborted || err.name === "AbortError") reject(new OutboundError("Request timed out or was aborted", "timeout"));
      else reject(new OutboundError(`${err.code ?? "ERR"}: ${err.message}`, "connect"));
    });
    if (o.body) req.write(o.body);
    req.end();
  });
}
