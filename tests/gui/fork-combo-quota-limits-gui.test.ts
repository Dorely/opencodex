import { describe, expect, test } from "bun:test";
import { draftEquals, emptyDraft, parseComboList, toPutBody } from "../../gui/src/combo-workspace-data";
import { parseComboQuotaLimits, quotaLimitsForSave, setQuotaLimitWindow } from "../../gui/src/fork/combo-quota-limits";

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
});
