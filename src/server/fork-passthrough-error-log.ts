/**
 * Fork (see FORK.md, "Passthrough error log"): keeps what the Anthropic passthrough otherwise
 * discards when the upstream answers 4xx/5xx, so an intermittent failure can be diagnosed from
 * its own words. One redacted JSON line per failure in `<configDir>/fork/passthrough-errors.jsonl`.
 * Never records credentials or request bodies; only the kind of credential that was sent.
 */
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";
import { redactSecretString } from "../lib/redact";

const MAX_BODY_CHARS = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const REQUEST_HEADERS = ["anthropic-version", "anthropic-beta", "user-agent", "x-app"] as const;
const RESPONSE_HEADERS = ["request-id", "x-should-retry", "cf-ray", "server", "via", "content-type"] as const;

export function passthroughErrorLogPath(configDir = getConfigDir()): string {
  return join(configDir, "fork", "passthrough-errors.jsonl");
}

/** Which credential the request carried, by shape only. */
export function credentialKind(headers: Headers): string {
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const key = headers.get("x-api-key")?.trim();
  const kind = (token: string): string => token.startsWith("sk-ant-oat") ? "oauth" : token.startsWith("sk-ant-api") ? "api-key" : "other";
  if (bearer && key) return `authorization:${kind(bearer)}+x-api-key:${kind(key)}`;
  if (bearer) return `authorization:${kind(bearer)}`;
  if (key) return `x-api-key:${kind(key)}`;
  return "none";
}

function pick(headers: Headers, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value) out[name] = redactSecretString(value).slice(0, 500);
  }
  return out;
}

export interface PassthroughErrorInput {
  status: number;
  /** Upstream path and query, without the host. */
  path: string;
  model: string;
  body: string;
  /** Headers as sent upstream. */
  requestHeaders: Headers;
  responseHeaders: Headers;
}

export function buildPassthroughErrorRecord(input: PassthroughErrorInput, now = Date.now()): Record<string, unknown> {
  return {
    at: new Date(now).toISOString(),
    status: input.status,
    path: input.path,
    model: input.model,
    credential: credentialKind(input.requestHeaders),
    request: pick(input.requestHeaders, REQUEST_HEADERS),
    response: pick(input.responseHeaders, RESPONSE_HEADERS),
    body: redactSecretString(input.body).slice(0, MAX_BODY_CHARS),
  };
}

/** Append one failure. Never throws: diagnostics must not change the response. */
export function logPassthroughUpstreamError(input: PassthroughErrorInput, path = passthroughErrorLogPath()): void {
  try {
    try { if (statSync(path).size > MAX_FILE_BYTES) return; } catch { /* first write */ }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(buildPassthroughErrorRecord(input))}\n`, { encoding: "utf8", mode: 0o600 });
  } catch { /* best effort */ }
}
