import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { comboExclusionReasons, pickComboTarget } from "../../src/combos";
import { comboConfigIssues, getCombo } from "../../src/combos/types";
import { comboQuotaLimitsConfigured } from "../../src/combos/quota-limits";
import { comboTargetQuotaLimitExceeded } from "../../src/combos/quota-limit-check";
import {
  comboQuotaLimitRefresherRunning,
  reconcileComboQuotaLimitRefresher,
  setComboQuotaRefreshForTests,
  startComboQuotaLimitRefresher,
} from "../../src/combos/combo-quota-limit-refresher";
import { clearCachedProviderQuotas, setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";
import type { OcxConfig } from "../../src/types";

// Fork: a combo can refuse a provider's targets while that provider's 5h or weekly quota usage
// is above a percent the combo sets (src/combos/quota-limits.ts).
// A real epoch-ms clock: reports carry reset times in epoch seconds or milliseconds.
const now = 1_795_034_983_423;
const limits = [{ provider: "commandcode", fiveHourPercent: 50, weeklyPercent: 50 }];
function config(quotaLimits: unknown = limits): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "commandcode",
    providers: {
      commandcode: { adapter: "openai-chat", baseUrl: "https://cc.example/v1", apiKey: "k", models: ["claude-opus-5"] },
      other: { adapter: "openai-chat", baseUrl: "https://other.example/v1", apiKey: "k2", models: ["m1"] },
    },
    combos: {
      Expensive: { quotaLimits, targets: [{ provider: "commandcode", model: "claude-opus-5" }, { provider: "other", model: "m1" }] },
      OnlyCc: { quotaLimits, targets: [{ provider: "commandcode", model: "claude-opus-5" }] },
      Unlimited: { targets: [{ provider: "commandcode", model: "claude-opus-5" }] },
    },
  } as unknown as OcxConfig;
}

beforeEach(() => { clearCachedProviderQuotas(); });
afterEach(() => { clearCachedProviderQuotas(); });

describe("combo quota limits", () => {
  test("normalization attaches the limit to the provider's targets only", () => {
    const combo = getCombo(config(), "Expensive")!;
    expect(combo.targets[0]!.quotaLimit).toEqual({ fiveHourPercent: 50, weeklyPercent: 50 });
    expect(combo.targets[1]!.quotaLimit).toBeUndefined();
    expect(getCombo(config(), "Unlimited")!.targets[0]!.quotaLimit).toBeUndefined();
  });

  test("under the limit the provider's target is picked", () => {
    setCachedProviderQuotaForTests("commandcode", { fiveHourPercent: 40, weeklyPercent: 50, updatedAt: now });
    expect(pickComboTarget(config(), "Expensive", { now })?.target.provider).toBe("commandcode");
  });

  test("over the 5-hour limit the combo skips to another provider", () => {
    setCachedProviderQuotaForTests("commandcode", { fiveHourPercent: 51, weeklyPercent: 10, updatedAt: now });
    expect(pickComboTarget(config(), "Expensive", { now })?.target.provider).toBe("other");
  });

  test("over the weekly limit the combo skips to another provider", () => {
    setCachedProviderQuotaForTests("commandcode", { fiveHourPercent: 0, weeklyPercent: 75, updatedAt: now });
    expect(pickComboTarget(config(), "Expensive", { now })?.target.provider).toBe("other");
  });

  test("a combo with no other target is unavailable, naming the quota limit", () => {
    setCachedProviderQuotaForTests("commandcode", { fiveHourPercent: 90, updatedAt: now });
    const cfg = config();
    expect(pickComboTarget(cfg, "OnlyCc", { now })).toBeNull();
    expect(comboExclusionReasons(cfg, "OnlyCc", undefined, now)).toContain("quota limit");
  });

  test("other combos on the same provider are unaffected", () => {
    setCachedProviderQuotaForTests("commandcode", { fiveHourPercent: 90, weeklyPercent: 90, updatedAt: now });
    expect(pickComboTarget(config(), "Unlimited", { now })?.target.provider).toBe("commandcode");
  });

  test("unknown, stale and already-reset usage does not block", () => {
    const target = getCombo(config(), "OnlyCc")!.targets[0]!;
    expect(comboTargetQuotaLimitExceeded(config(), target, now)).toBe(false);
    setCachedProviderQuotaForTests("commandcode", { fiveHourPercent: 90, updatedAt: now - 31 * 60_000 });
    expect(comboTargetQuotaLimitExceeded(config(), target, now)).toBe(false);
    setCachedProviderQuotaForTests("commandcode", { fiveHourPercent: 90, fiveHourResetAt: now - 1, updatedAt: now });
    expect(comboTargetQuotaLimitExceeded(config(), target, now)).toBe(false);
    setCachedProviderQuotaForTests("commandcode", { fiveHourPercent: 90, fiveHourResetAt: now + 60_000, updatedAt: now });
    expect(comboTargetQuotaLimitExceeded(config(), target, now)).toBe(true);
  });

  test("a Codex report with reset times in epoch seconds still blocks", () => {
    // Live shape of the native OpenAI (chatgpt:wham) report, a forward-auth provider whose only
    // evidence is the dashboard report.
    const cfg = {
      ...config([{ provider: "openai", fiveHourPercent: 75, weeklyPercent: 75 }]),
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.example/backend-api/codex", authMode: "forward" },
        other: { adapter: "openai-chat", baseUrl: "https://other.example/v1", apiKey: "k2", models: ["m1"] },
      },
      combos: { Expensive: { quotaLimits: [{ provider: "openai", fiveHourPercent: 75, weeklyPercent: 75 }],
        targets: [{ provider: "openai", model: "gpt-6.2-sol" }, { provider: "other", model: "m1" }] } },
    } as unknown as OcxConfig;
    const seconds = Math.floor(now / 1000);
    setCachedProviderQuotaForTests("openai", { fiveHourPercent: 100, fiveHourResetAt: seconds + 14_000, weeklyPercent: 22, weeklyResetAt: seconds + 600_000, updatedAt: now });
    expect(pickComboTarget(cfg, "Expensive", { now })?.target.provider).toBe("other");
    setCachedProviderQuotaForTests("openai", { fiveHourPercent: 76, fiveHourResetAt: seconds + 14_000, updatedAt: now });
    expect(pickComboTarget(cfg, "Expensive", { now })?.target.provider).toBe("other");
    // A seconds-unit reset that already passed no longer blocks.
    setCachedProviderQuotaForTests("openai", { fiveHourPercent: 100, fiveHourResetAt: seconds - 1, updatedAt: now });
    expect(pickComboTarget(cfg, "Expensive", { now })?.target.provider).toBe("openai");
  });

  test("exactly at the limit is allowed; a single-window limit ignores the other window", () => {
    setCachedProviderQuotaForTests("commandcode", { fiveHourPercent: 50, weeklyPercent: 50, updatedAt: now });
    expect(pickComboTarget(config(), "OnlyCc", { now })?.target.provider).toBe("commandcode");
    setCachedProviderQuotaForTests("commandcode", { fiveHourPercent: 10, weeklyPercent: 99, updatedAt: now });
    const fiveHourOnly = config([{ provider: "commandcode", fiveHourPercent: 50 }]);
    expect(pickComboTarget(fiveHourOnly, "OnlyCc", { now })?.target.provider).toBe("commandcode");
  });

  test("validation rejects malformed limits", () => {
    const providers = config().providers;
    const issues = (quotaLimits: unknown) => comboConfigIssues("X", { targets: [{ provider: "commandcode", model: "m" }], quotaLimits }, providers)
      .filter(issue => issue.path[0] === "quotaLimits").map(issue => issue.message);
    expect(issues(limits)).toEqual([]);
    expect(issues({})).toEqual(["quotaLimits must be an array"]);
    expect(issues([{ provider: "commandcode" }])).toEqual(["quota limit needs fiveHourPercent or weeklyPercent"]);
    expect(issues([{ provider: "commandcode", weeklyPercent: 101 }])).toEqual(["weeklyPercent must be a number from 0 to 100"]);
    expect(issues([{ provider: "", weeklyPercent: 5 }])).toEqual(["quota limit provider must be a non-empty provider name"]);
    expect(issues([{ provider: "a", weeklyPercent: 5 }, { provider: "a", fiveHourPercent: 5 }])).toEqual(["quota limit for provider \"a\" is declared twice"]);
    expect(issues([{ provider: "a", weeklyPercent: 5, monthly: 1 }])).toEqual(["unknown quota limit field \"monthly\""]);
  });

  test("the refresher runs only while a combo declares a limit", async () => {
    const calls: number[] = [];
    setComboQuotaRefreshForTests(async () => { calls.push(1); });
    const stop = startComboQuotaLimitRefresher(config([]));
    try {
      expect(comboQuotaLimitsConfigured(config([]))).toBe(false);
      expect(comboQuotaLimitRefresherRunning()).toBe(false);
      reconcileComboQuotaLimitRefresher(config());
      expect(comboQuotaLimitRefresherRunning()).toBe(true);
      await Promise.resolve();
      expect(calls.length).toBe(1);
      reconcileComboQuotaLimitRefresher(config([]));
      expect(comboQuotaLimitRefresherRunning()).toBe(false);
    } finally {
      stop();
      setComboQuotaRefreshForTests(undefined);
    }
  });
});
