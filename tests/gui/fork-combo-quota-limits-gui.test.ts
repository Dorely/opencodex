import { describe, expect, test } from "bun:test";
import { draftEquals, emptyDraft, parseComboList, toPutBody } from "../../gui/src/combo-workspace-data";
import { parseComboQuotaLimits, parseComboSpend, quotaLimitsForSave, setQuotaLimitWindow } from "../../gui/src/fork/combo-quota-limits";

// Fork: the dashboard edits per-combo provider quota cutoffs (gui/src/fork/combo-quota-limits.ts).
describe("dashboard combo quota cutoffs", () => {
  test("parse keeps valid rows and drops malformed ones", () => {
    expect(parseComboQuotaLimits([
      { provider: "cc", fiveHourPercent: 50, weeklyPercent: 50 },
      { provider: "cc", weeklyPercent: 10 },
      { provider: "x" },
      { provider: "y", weeklyPercent: 101 },
      "junk",
    ])).toEqual([{ provider: "cc", fiveHourPercent: 50, weeklyPercent: 50 }]);
  });

  test("a combo row round-trips its limits through list parsing and the save body", () => {
    const [item] = parseComboList({ combos: [{ id: "commandcode-expensive", targets: [{ provider: "commandcode", model: "m" }],
      quotaLimits: [{ provider: "commandcode", fiveHourPercent: 50, weeklyPercent: 50 }] }] });
    expect(item!.quotaLimits).toEqual([{ provider: "commandcode", fiveHourPercent: 50, weeklyPercent: 50 }]);
    expect(toPutBody(item!).combo.quotaLimits).toEqual([{ provider: "commandcode", fiveHourPercent: 50, weeklyPercent: 50 }]);
  });

  test("editing a window marks the draft dirty, clearing both removes the row", () => {
    const base = { ...emptyDraft("c"), targets: [{ provider: "cc", model: "m" }] } as ReturnType<typeof emptyDraft>;
    const set = { ...base, quotaLimits: setQuotaLimitWindow(base.quotaLimits, "cc", "fiveHourPercent", 50) };
    expect(draftEquals(base, set)).toBe(false);
    const cleared = setQuotaLimitWindow(set.quotaLimits, "cc", "fiveHourPercent", undefined);
    expect(cleared).toEqual([]);
    expect(draftEquals(base, { ...base, quotaLimits: cleared })).toBe(true);
  });

  test("save sends only targeted providers, an explicit empty list once cleared, nothing when untouched", () => {
    const limits = [{ provider: "cc", weeklyPercent: 40 }, { provider: "gone", weeklyPercent: 10 }];
    expect(quotaLimitsForSave(limits, [{ provider: "cc" }])).toEqual([{ provider: "cc", weeklyPercent: 40 }]);
    const draft = { ...emptyDraft("c"), targets: [{ provider: "cc", model: "m" }] } as ReturnType<typeof emptyDraft>;
    expect(Object.hasOwn(toPutBody(draft).combo, "quotaLimits")).toBe(false);
    expect(toPutBody({ ...draft, quotaLimits: [] }).combo.quotaLimits).toEqual([]);
  });

  test("spend limits parse, edit and round-trip in dollars", () => {
    expect(parseComboQuotaLimits([{ provider: "api", weeklySpendUsd: 25.5, monthlySpendUsd: 80 }, { provider: "bad", monthlySpendUsd: -1 }]))
      .toEqual([{ provider: "api", weeklySpendUsd: 25.5, monthlySpendUsd: 80 }]);
    const set = setQuotaLimitWindow([{ provider: "api", weeklyPercent: 50 }], "api", "monthlySpendUsd", 120);
    expect(set).toEqual([{ provider: "api", weeklyPercent: 50, monthlySpendUsd: 120 }]);
    expect(quotaLimitsForSave(set, [{ provider: "api" }])).toEqual([{ provider: "api", weeklyPercent: 50, monthlySpendUsd: 120 }]);
    expect(parseComboSpend({ providers: { api: { weekUsd: 1.5, monthUsd: 4, unpricedRequests: 2 }, junk: {} } }))
      .toEqual({ api: { weekUsd: 1.5, monthUsd: 4, unpricedRequests: 2 } });
    expect(parseComboSpend({ providers: null })).toBeNull();
  });
});
