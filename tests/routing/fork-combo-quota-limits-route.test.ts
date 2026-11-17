import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getConfigPath, saveConfig } from "../../src/config";
import { handleComboRoutes } from "../../src/server/management/combo-routes";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

// Fork: a dashboard save stores combo-level `quotaLimits` (never the runtime per-target copy)
// and lists them back, so a reload shows the cutoffs it saved.
const refresh = { status: "committed" as const, changed: false, degraded: false, notices: [] };
const targets = [{ provider: "cc", model: "google/gemini-4-carbon" }];
const limits = [{ provider: "cc", fiveHourPercent: 50, weeklyPercent: 50 }];
let home: TempHome;
let token: string | undefined;
let network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-fork-combo-quota-route-");
  token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  network.mockRestore();
  if (token === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = token;
  home.remove();
});
function config(): OcxConfig {
  return {
    port: 10100, defaultProvider: "cc",
    providers: { cc: { adapter: "openai-chat", baseUrl: "https://cc.invalid/v1", models: ["google/gemini-4-carbon"], liveModels: false } },
  };
}
async function api(cfg: OcxConfig, method: string, body?: unknown): Promise<Response> {
  const req = new Request("http://ocx.invalid/api/combos", {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await handleComboRoutes({
    req, url: new URL(req.url), config: cfg, deps: {}, version: "fixture",
    trustedLoopbackIngress: true, guiSessionIssuance: null,
    convergeCodexCatalog: async () => refresh,
    syncClaudeAgentDefsBestEffort: async () => {},
  });
  return response!;
}
const stored = () => JSON.parse(readFileSync(getConfigPath(), "utf8")).combos;

describe("combo quota limits through the management route", () => {
  test("save stores combo-level limits, lists them, and an empty list clears them", async () => {
    const cfg = config();
    saveConfig(cfg);
    expect((await api(cfg, "PUT", { id: "x", combo: { targets, quotaLimits: limits } })).status).toBe(200);
    expect(stored().x.quotaLimits).toEqual(limits);
    expect(stored().x.targets[0]).not.toHaveProperty("quotaLimit");
    const listed = (await (await api(cfg, "GET")).json()).combos as Record<string, unknown>[];
    expect(listed.find(row => row.id === "x")?.quotaLimits).toEqual(limits);

    expect((await api(cfg, "PUT", { id: "x", combo: { targets } })).status).toBe(200);
    expect(stored().x.quotaLimits).toEqual(limits);
    expect((await api(cfg, "PUT", { id: "x", combo: { targets, quotaLimits: [] } })).status).toBe(200);
    expect(stored().x).not.toHaveProperty("quotaLimits");
  });
});
