import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildPassthroughErrorRecord, credentialKind, logPassthroughUpstreamError, withRelayedErrorDetails } from "../../src/server/fork-passthrough-error-log";
import { createTempHome, type TempHome } from "../helpers/temp-home";

// Fork: the Anthropic passthrough keeps the upstream's error body for diagnosis, without credentials.
let home: TempHome;
beforeEach(() => { home = createTempHome("ocx-fork-passthrough-log-"); });
afterEach(() => { home.remove(); });

const TOKEN = `sk-ant-oat01-${"a".repeat(60)}`;
function input(body: string) {
  return {
    status: 404, path: "/v1/messages?beta=true", model: "claude-opus-5-5", body,
    requestHeaders: new Headers({ authorization: `Bearer ${TOKEN}`, "anthropic-beta": "one,two", "anthropic-version": "2023-06-01", cookie: "x=1" }),
    responseHeaders: new Headers({ "request-id": "req_123", "set-cookie": "y=2" }),
  };
}

describe("passthrough error log", () => {
  test("records the body and chosen headers, never the credential", () => {
    const record = buildPassthroughErrorRecord(input(`{"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-5-5 ${TOKEN}"}}`), 0);
    const text = JSON.stringify(record);
    expect(record).toMatchObject({ status: 404, path: "/v1/messages?beta=true", model: "claude-opus-5-5", credential: "authorization:oauth" });
    expect(record.request).toEqual({ "anthropic-version": "2023-06-01", "anthropic-beta": "one,two" });
    expect(record.response).toEqual({ "request-id": "req_123" });
    expect(text).toContain("not_found_error");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("x=1");
    expect((buildPassthroughErrorRecord(input("z".repeat(9000)), 0).body as string).length).toBe(2000);
  });

  test("credential kind is shape only", () => {
    expect(credentialKind(new Headers())).toBe("none");
    expect(credentialKind(new Headers({ "x-api-key": "sk-ant-api03-zzz" }))).toBe("x-api-key:api-key");
    expect(credentialKind(new Headers({ authorization: "Bearer whatever" }))).toBe("authorization:other");
  });

  test("appends one JSON line per failure", () => {
    const path = home.path("fork/passthrough-errors.jsonl");
    logPassthroughUpstreamError(input("first"), path);
    logPassthroughUpstreamError(input("second"), path);
    const lines = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(lines.map(line => line.body)).toEqual(["first", "second"]);
  });

  test("relays thread_not_found so Claude Code replays the conversation", () => {
    const owned = { type: "error", error: { type: "not_found_error", message: "The requested model is unavailable." } };
    const upstream = { type: "error", error: { type: "not_found_error", message: "No thread state was found for the requested `previous_message_id`.", details: { error_code: "thread_not_found" } } };
    expect(withRelayedErrorDetails(owned, upstream)).toEqual({ type: "error", error: {
      type: "not_found_error", message: "No thread state was found for the requested `previous_message_id`.", details: { error_code: "thread_not_found" } } });
    // Other codes and shapes keep the owned body.
    const other = { error: { message: "x", details: { error_code: "model_not_found" } } };
    expect(withRelayedErrorDetails(owned, other)).toBe(owned);
    expect(withRelayedErrorDetails(owned, undefined)).toBe(owned);
    expect(withRelayedErrorDetails(owned, { error: "nope" })).toBe(owned);
  });
});
