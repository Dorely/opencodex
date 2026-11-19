import { afterEach, describe, expect, test } from "bun:test";
import { comboExclusionReasons, pickComboTarget } from "../../src/combos";
import { comboConfigIssues } from "../../src/combos/types";
import { comboSpendLimitsConfigured, normalizeComboQuotaLimits } from "../../src/combos/quota-limits";
import { comboTargetSpendLimitReached } from "../../src/combos/quota-limit-check";
import {
  addEntrySpend, localDayKey, monthStartMs, newSpendBuckets, setComboSpendBucketsForTests, spendFromBuckets, weekStartMs,
} from "../../src/combos/spend-tracker";
import { handleForkComboSpendRoutes } from "../../src/server/management/fork-combo-spend";
import type { PersistedUsageEntry } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";

// Fork: combo spend limits cap a provider by its estimated USD spend this calendar week or month.
afterEach(() => setComboSpendBucketsForTests(null));

// Wednesday 2026-11-18, 12:00 local.
const now = new Date(2026, 10, 18, 12).getTime();
const day = (date: number, hour = 12) => new Date(2026, 10, date, hour).getTime();

function entry(provider: string, at: number, inputTokens: number, extra: Record<string, unknown> = {}): PersistedUsageEntry {
  return { requestId: `r${at}`, timestamp: at, provider, model: "claude-sonnet-5-5", status: 200, durationMs: 1,
    usageStatus: "reported", usage: { inputTokens, outputTokens: 0 }, ...extra } as unknown as PersistedUsageEntry;
}

function config(limit: Record<string, number>): OcxConfig {
  return {
    port: 10100, defaultProvider: "api",
    providers: {
      api: { adapter: "anthropic", baseUrl: "https://api.anthropic.example", apiKey: "k", models: ["claude-sonnet-5-5"] },
      other: { adapter: "openai-chat", baseUrl: "https://other.example/v1", apiKey: "k2", models: ["m1"] },
    },
    combos: { Expensive: { quotaLimits: [{ provider: "api", ...limit }],
      targets: [{ provider: "api", model: "claude-sonnet-5-5" }, { provider: "other", model: "m1" }] } },
  } as unknown as OcxConfig;
}

function oneRequestUsd(): number {
  const buckets = newSpendBuckets();
  addEntrySpend(buckets, entry("api", now, 1_000_000), now);
  return spendFromBuckets(buckets, "api", now).weekUsd;
}

describe("calendar windows", () => {
  test("week starts Monday 00:00 local, month on the 1st", () => {
    expect(localDayKey(weekStartMs(now))).toBe("2026-11-16");
    expect(new Date(weekStartMs(now)).getHours()).toBe(0);
    expect(localDayKey(monthStartMs(now))).toBe("2026-11-01");
    // A Sunday belongs to the week that began the Monday before.
    expect(localDayKey(weekStartMs(day(22)))).toBe("2026-11-16");
    expect(localDayKey(weekStartMs(day(23)))).toBe("2026-11-23");
  });
});

describe("spend tracking", () => {
  test("sums priced requests per provider into week and month", () => {
    const one = oneRequestUsd();
    expect(one).toBeGreaterThan(0);
    const buckets = newSpendBuckets();
    addEntrySpend(buckets, entry("api", day(17), 1_000_000), now); // this week
    addEntrySpend(buckets, entry("api", day(10), 1_000_000), now); // this month, last week
    addEntrySpend(buckets, entry("api", new Date(2026, 9, 30).getTime(), 1_000_000), now); // last month
    addEntrySpend(buckets, entry("other", day(17), 1_000_000), now);
    const spend = spendFromBuckets(buckets, "api", now);
    expect(spend.weekUsd).toBeCloseTo(one);
    expect(spend.monthUsd).toBeCloseTo(one * 2);
    expect(spendFromBuckets(buckets, "missing", now)).toEqual({ weekUsd: 0, monthUsd: 0, unpricedRequests: 0 });
  });

  test("combo rows count each attempt on its own provider; unpriced usage is counted, not priced", () => {
    const buckets = newSpendBuckets();
    const attempt = (provider: string, model: string) => ({ ordinal: 0, provider, model, adapter: "x", status: 200, durationMs: 1,
      usageStatus: "reported", usage: { inputTokens: 1_000_000, outputTokens: 0 } });
    addEntrySpend(buckets, entry("combo", day(17), 0, { attempts: [attempt("api", "claude-sonnet-5-5"), attempt("api", "no-such-model-xyz")] }), now);
    const spend = spendFromBuckets(buckets, "api", now);
    expect(spend.weekUsd).toBeGreaterThan(0);
    expect(spend.unpricedRequests).toBe(1);
    expect(spendFromBuckets(buckets, "combo", now).weekUsd).toBe(0);
  });
});

describe("spend limits in combo routing", () => {
  test("validation accepts dollar limits and rejects bad ones", () => {
    const providers = config({}).providers;
    const issues = (quotaLimits: unknown) => comboConfigIssues("X", { targets: [{ provider: "api", model: "claude-sonnet-5-5" }], quotaLimits }, providers);
    expect(issues([{ provider: "api", weeklySpendUsd: 25.5, monthlySpendUsd: 80 }])).toEqual([]);
    expect(issues([{ provider: "api", weeklySpendUsd: -1 }]).length).toBeGreaterThan(0);
    expect(issues([{ provider: "api", monthlySpendUsd: 2_000_000 }]).length).toBeGreaterThan(0);
    expect(normalizeComboQuotaLimits([{ provider: "api", monthlySpendUsd: 80 }]).get("api")).toEqual({ monthlySpendUsd: 80 });
    expect(comboSpendLimitsConfigured(config({ monthlySpendUsd: 80 }))).toBe(true);
    expect(comboSpendLimitsConfigured(config({ weeklyPercent: 80 }))).toBe(false);
  });

  test("a provider at or over its weekly or monthly limit is skipped", () => {
    const buckets = newSpendBuckets();
    setComboSpendBucketsForTests(buckets);
    expect(pickComboTarget(config({ weeklySpendUsd: 1 }), "Expensive", { now })?.target.provider).toBe("api");
    addEntrySpend(buckets, entry("api", day(17), 1_000_000), now);
    const used = spendFromBuckets(buckets, "api", now).weekUsd;
    expect(pickComboTarget(config({ weeklySpendUsd: used + 0.01 }), "Expensive", { now })?.target.provider).toBe("api");
    expect(pickComboTarget(config({ weeklySpendUsd: used }), "Expensive", { now })?.target.provider).toBe("other");
    expect(comboExclusionReasons(config({ weeklySpendUsd: used }), "Expensive", { now })).toContain("spend limit");
    // Spend from an earlier week still counts toward the month.
    addEntrySpend(buckets, entry("api", day(3), 1_000_000), now);
    expect(pickComboTarget(config({ weeklySpendUsd: used + 0.01, monthlySpendUsd: used * 2 }), "Expensive", { now })?.target.provider).toBe("other");
  });

  test("unknown spend (no scan yet) does not block", () => {
    expect(comboTargetSpendLimitReached({ provider: "api", quotaLimit: { weeklySpendUsd: 0 } }, now)).toBe(false);
  });

  test("the dashboard reads current spend per provider", async () => {
    const buckets = newSpendBuckets();
    addEntrySpend(buckets, entry("api", Date.now(), 1_000_000));
    setComboSpendBucketsForTests(buckets);
    const req = new Request("http://ocx.invalid/api/fork/combo-spend");
    const response = await handleForkComboSpendRoutes({ req, url: new URL(req.url) }, async () => {});
    const body = await response!.json();
    expect(body.providers.api.weekUsd).toBeGreaterThan(0);
    expect(typeof body.weekStart).toBe("string");
    const other = new Request("http://ocx.invalid/api/other");
    expect(await handleForkComboSpendRoutes({ req: other, url: new URL(other.url) }, async () => {})).toBeNull();
  });
});
