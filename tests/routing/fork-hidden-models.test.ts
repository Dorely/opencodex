import { describe, expect, test } from "bun:test";
import { previewRouteModel } from "../../src/router";
import {
  assertModelNotHidden,
  hiddenRequestedComboId,
  HiddenModelError,
  isHiddenModelRequest,
} from "../../src/routing/hidden-models";
import type { OcxConfig } from "../../src/types";

// Fork: a hidden (`disabledModels`) model is refused when the client names it, not only omitted
// from discovery. Operator-configured routes (combo targets, policy picks, redirects) still pass.
function config(disabledModels: string[], extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "cc",
    providers: {
      cc: { adapter: "openai-chat", baseUrl: "https://cc.example/v1", apiKey: "k", models: ["claude-opus-5", "deepseek-flash"] },
      other: { adapter: "openai-chat", baseUrl: "https://other.example/v1", apiKey: "k2", models: ["m1"] },
    },
    disabledModels,
    ...extra,
  } as unknown as OcxConfig;
}

describe("hidden model refusal", () => {
  test("a hidden provider/model named in full is refused", () => {
    const cfg = config(["cc/claude-opus-5"]);
    const route = previewRouteModel(cfg, "cc/claude-opus-5");
    expect(isHiddenModelRequest(cfg, "cc/claude-opus-5", route)).toBe(true);
    expect(() => assertModelNotHidden(cfg, "cc/claude-opus-5", route)).toThrow(HiddenModelError);
  });

  test("a bare id that resolves to a hidden model is refused", () => {
    const cfg = config(["cc/claude-opus-5"]);
    const route = previewRouteModel(cfg, "claude-opus-5");
    expect(route.providerName).toBe("cc");
    expect(isHiddenModelRequest(cfg, "claude-opus-5", route)).toBe(true);
  });

  test("a visible model on the same provider still routes", () => {
    const cfg = config(["cc/claude-opus-5"]);
    expect(isHiddenModelRequest(cfg, "cc/deepseek-flash", previewRouteModel(cfg, "cc/deepseek-flash"))).toBe(false);
    expect(isHiddenModelRequest(config([]), "cc/claude-opus-5", previewRouteModel(config([]), "cc/claude-opus-5"))).toBe(false);
  });

  test("the error names the requested selector", () => {
    expect(new HiddenModelError("cc/claude-opus-5").message).toContain("\"cc/claude-opus-5\" is hidden");
    expect(new HiddenModelError("x").code).toBe("model_hidden");
  });

  test("a bare native GPT id hides that model", () => {
    const cfg = config(["gpt-5.5"]);
    const route = { providerName: "openai", modelId: "gpt-5.5", routeKind: "native" };
    expect(isHiddenModelRequest(cfg, "gpt-5.5", route)).toBe(true);
    expect(isHiddenModelRequest(cfg, "gpt-6.1-sol", { ...route, modelId: "gpt-6.1-sol" })).toBe(false);
  });

  test("Codex's own helper and memory models stay callable when hidden", () => {
    const cfg = config(["gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(isHiddenModelRequest(cfg, "gpt-5.6-luna", { providerName: "openai", modelId: "gpt-5.6-luna" })).toBe(false);
    expect(isHiddenModelRequest(cfg, "gpt-5.6-terra", { providerName: "openai", modelId: "gpt-5.6-terra" })).toBe(false);
  });

  test("operator-chosen destinations are not refused", () => {
    const cfg = config(["cc/claude-opus-5"]);
    const target = { providerName: "cc", modelId: "claude-opus-5" };
    expect(isHiddenModelRequest(cfg, "policy/fast", { ...target, routeKind: "policy" })).toBe(false);
    expect(isHiddenModelRequest(cfg, "other/m1", { ...target, routeReason: "blocked-model-redirect" })).toBe(false);
  });

  test("a hidden combo is refused, a visible combo with hidden targets is not", () => {
    const combos = {
      Expensive: { targets: [{ provider: "cc", model: "claude-opus-5" }] },
      Cheap: { alias: "cheap", targets: [{ provider: "cc", model: "claude-opus-5" }] },
    };
    const cfg = config(["cc/claude-opus-5", "combo/Expensive"], { combos } as Partial<OcxConfig>);
    const target = { providerName: "cc", modelId: "claude-opus-5" };
    expect(isHiddenModelRequest(cfg, "combo/Expensive", { ...target, combo: { comboId: "Expensive" } })).toBe(true);
    expect(isHiddenModelRequest(cfg, "cheap", { ...target, combo: { comboId: "Cheap" } })).toBe(false);
    expect(hiddenRequestedComboId(cfg, "combo/Expensive")).toBe("Expensive");
    expect(hiddenRequestedComboId(cfg, "cheap")).toBeNull();
    // A combo hidden by its public alias.
    const byAlias = config(["cheap"], { combos } as Partial<OcxConfig>);
    expect(hiddenRequestedComboId(byAlias, "cheap")).toBe("Cheap");
    expect(hiddenRequestedComboId(byAlias, "combo/Cheap")).toBe("Cheap");
  });
});
