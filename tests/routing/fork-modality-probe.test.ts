import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { getConfigPath, saveConfig } from "../../src/config";
import {
  currentDeclaredModalities, handleForkModalityProbeRoutes, readModalityProbes, runImageProbe, withImageModality,
  type ProbeSender,
} from "../../src/server/management/fork-modality-probe";
import { MODALITY_PROBE_HEADER } from "../../src/routing/hidden-models";
import { setInternalCallCapabilityForTests } from "../../src/lib/local-internal-call-capability";
import { answerMatchesCode, randomProbeCode, renderDigitsPng } from "../../src/vision/fork-probe-image";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

// Fork: a modality probe sends a model a picture of a number; only a correct read-back declares image.
const CAPABILITY = "A".repeat(43);
const refresh = { status: "committed" as const, changed: false, degraded: false, notices: [] };
let home: TempHome;
let token: string | undefined;
let network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-fork-modality-probe-");
  token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
  setInternalCallCapabilityForTests(CAPABILITY);
});
afterEach(() => {
  setInternalCallCapabilityForTests(null);
  network.mockRestore();
  if (token === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = token;
  home.remove();
});

const MODEL = "google/gemini-4-carbon";
function config(extra: Record<string, unknown> = {}): OcxConfig {
  return {
    port: 10100, defaultProvider: "cc", disabledModels: [`cc/${MODEL}`],
    providers: { cc: { adapter: "openai-chat", baseUrl: "https://cc.invalid/v1", models: [MODEL], liveModels: false, ...extra } },
  } as unknown as OcxConfig;
}
type Call = { body: any; headers: Record<string, string> };
function replying(reply: (code: string) => string): { send: ProbeSender; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, send: async (body, headers) => { calls.push({ body, headers }); return { text: reply("40213") }; } };
}
async function api(cfg: OcxConfig, method: string, body?: unknown, send?: ProbeSender) {
  const req = new Request("http://ocx.invalid/api/fork/modality-probes", {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let converged = 0;
  const response = await handleForkModalityProbeRoutes({
    req, url: new URL(req.url), config: cfg, deps: {},
    convergeCodexCatalog: async () => { converged += 1; return refresh; },
  }, { code: "40213", ...(send ? { send } : {}), storePath: home.path("probes.json") });
  return { response: response!, converged };
}

describe("probe image", () => {
  test("renders a valid grayscale PNG with ink and paper", () => {
    const png = renderDigitsPng("40213");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    const width = view.getUint32(16), height = view.getUint32(20);
    const idatLength = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(raw.length).toBe(height * (width + 1));
    expect(raw.includes(0)).toBe(true);
    expect(raw.includes(255)).toBe(true);
    expect(() => renderDigitsPng("12a")).toThrow();
  });

  test("codes and answer matching", () => {
    expect(randomProbeCode(5, () => 0)).toBe("10000");
    expect(randomProbeCode(5, () => 0.99)).toMatch(/^9\d{4}$/);
    expect(answerMatchesCode("40213", "40213")).toBe(true);
    expect(answerMatchesCode("The number is 40,213.", "40213")).toBe(true);
    expect(answerMatchesCode("4 0 2 1 3", "40213")).toBe(true);
    expect(answerMatchesCode("402130", "40213")).toBe(false);
    expect(answerMatchesCode("I cannot see images.", "40213")).toBe(false);
  });
});

describe("modality probe", () => {
  test("sends the exact model an image with the internal probe header", async () => {
    const { send, calls } = replying(code => code);
    const record = await runImageProbe(config(), "cc", MODEL, { send, code: "40213" });
    expect(record.ok).toBe(true);
    expect(calls[0]!.body.model).toBe(`cc/${MODEL}`);
    expect(calls[0]!.body.messages[0].content[1].image_url.url).toStartWith("data:image/png;base64,");
    expect(calls[0]!.headers[MODALITY_PROBE_HEADER]).toBe(CAPABILITY);
  });

  test("modality helpers keep text and add image", () => {
    expect(withImageModality(undefined)).toEqual(["text", "image"]);
    expect(withImageModality(["text", "audio"])).toEqual(["text", "audio", "image"]);
    expect(currentDeclaredModalities(config({ modelInputModalities: { [MODEL]: ["text"] } }), "cc", MODEL)).toEqual(["text"]);
  });

  test("a pass declares image and records the result", async () => {
    const cfg = config();
    saveConfig(cfg);
    const { response, converged } = await api(cfg, "POST", { provider: "cc", model: MODEL, modality: "image" }, replying(code => `It says ${code}`).send);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, declared: true });
    expect(converged).toBe(1);
    const saved = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    expect(saved.providers.cc.modelCapabilities[MODEL].inputModalities).toEqual(["text", "image"]);
    expect(readModalityProbes(home.path("probes.json"))[`cc/${MODEL}`]?.image?.ok).toBe(true);
    const listed = await (await api(cfg, "GET")).response.json();
    expect(listed.probes[`cc/${MODEL}`].image.ok).toBe(true);
  });

  test("a wrong reply declares nothing but is recorded", async () => {
    const cfg = config();
    saveConfig(cfg);
    const { response, converged } = await api(cfg, "POST", { provider: "cc", model: MODEL }, replying(() => "I cannot view images").send);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(converged).toBe(0);
    expect(cfg.providers.cc!.modelCapabilities).toBeUndefined();
    expect(readModalityProbes(home.path("probes.json"))[`cc/${MODEL}`]?.image?.ok).toBe(false);
  });

  test("refuses text-only models, native and combo rows, and bad input", async () => {
    const textOnly = config({ modelInputModalities: { [MODEL]: ["text"] } });
    expect((await api(textOnly, "POST", { provider: "cc", model: MODEL }, replying(code => code).send)).response.status).toBe(409);
    expect((await api(config(), "POST", { provider: "openai", model: "gpt-6.1-sol" })).response.status).toBe(400);
    expect((await api(config(), "POST", { provider: "combo", model: "expensive" })).response.status).toBe(400);
    expect((await api(config(), "POST", { provider: "nope", model: "m" })).response.status).toBe(404);
    expect((await api(config(), "POST", { provider: "cc", model: "m", modality: "audio" })).response.status).toBe(400);
    expect((await api(config(), "POST", { provider: "cc", model: "m", extra: 1 })).response.status).toBe(400);
  });
});
