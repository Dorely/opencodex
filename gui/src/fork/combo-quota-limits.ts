/**
 * Dashboard model for per-combo provider quota limits (fork feature, see FORK.md).
 * Mirrors `src/combos/quota-limits.ts`: one entry per provider, each window 0..100, at least one.
 */

export interface ComboQuotaLimitDraft {
  provider: string;
  fiveHourPercent?: number;
  weeklyPercent?: number;
}

export type ComboQuotaWindow = "fiveHourPercent" | "weeklyPercent";

function percent(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : undefined;
}

function withWindows(provider: string, fiveHourPercent: number | undefined, weeklyPercent: number | undefined): ComboQuotaLimitDraft {
  return {
    provider,
    ...(fiveHourPercent !== undefined ? { fiveHourPercent } : {}),
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
  };
}

/** Valid limits from a `/api/combos` row, sorted by provider; malformed rows are dropped. */
export function parseComboQuotaLimits(raw: unknown): ComboQuotaLimitDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: ComboQuotaLimitDraft[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const provider = typeof row.provider === "string" ? row.provider.trim() : "";
    if (!provider || out.some(limit => limit.provider === provider)) continue;
    const limit = withWindows(provider, percent(row.fiveHourPercent), percent(row.weeklyPercent));
    if (limit.fiveHourPercent !== undefined || limit.weeklyPercent !== undefined) out.push(limit);
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Distinct, non-empty target providers in target order. */
export function comboTargetProviders(targets: readonly { provider: string }[]): string[] {
  const out: string[] = [];
  for (const target of targets) {
    const provider = target.provider.trim();
    if (provider && !out.includes(provider)) out.push(provider);
  }
  return out;
}

/** The limits a save sends: only providers the combo still targets, only rows with a window. */
export function quotaLimitsForSave(
  limits: readonly ComboQuotaLimitDraft[] | undefined,
  targets: readonly { provider: string }[],
): ComboQuotaLimitDraft[] {
  const providers = new Set(comboTargetProviders(targets));
  return parseComboQuotaLimits((limits ?? []).filter(limit => providers.has(limit.provider)));
}

export function quotaLimitsEqual(
  a: readonly ComboQuotaLimitDraft[] | undefined,
  b: readonly ComboQuotaLimitDraft[] | undefined,
): boolean {
  return JSON.stringify(parseComboQuotaLimits(a ?? [])) === JSON.stringify(parseComboQuotaLimits(b ?? []));
}

/** Set (or clear, with undefined) one window of one provider's limit. */
export function setQuotaLimitWindow(
  limits: readonly ComboQuotaLimitDraft[] | undefined,
  provider: string,
  window: ComboQuotaWindow,
  value: number | undefined,
): ComboQuotaLimitDraft[] {
  const current = (limits ?? []).find(limit => limit.provider === provider);
  const next = { ...withWindows(provider, current?.fiveHourPercent, current?.weeklyPercent), [window]: percent(value) };
  const cleaned = withWindows(provider, next.fiveHourPercent, next.weeklyPercent);
  const rest = (limits ?? []).filter(limit => limit.provider !== provider);
  return cleaned.fiveHourPercent === undefined && cleaned.weeklyPercent === undefined ? rest : [...rest, cleaned];
}
