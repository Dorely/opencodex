/**
 * Dashboard model for per-combo provider quota limits (fork feature, see FORK.md).
 * Mirrors `src/combos/quota-limits.ts`: one entry per provider, percent windows 0..100, spend
 * limits in USD 0..1,000,000, at least one value per entry.
 */

export interface ComboQuotaLimitDraft {
  provider: string;
  fiveHourPercent?: number;
  weeklyPercent?: number;
  weeklySpendUsd?: number;
  monthlySpendUsd?: number;
}

export type ComboQuotaWindow = "fiveHourPercent" | "weeklyPercent" | "weeklySpendUsd" | "monthlySpendUsd";

export const COMBO_QUOTA_WINDOWS: readonly ComboQuotaWindow[] = ["fiveHourPercent", "weeklyPercent", "weeklySpendUsd", "monthlySpendUsd"];
export const MAX_SPEND_LIMIT_USD = 1_000_000;

export function isSpendWindow(window: ComboQuotaWindow): boolean {
  return window === "weeklySpendUsd" || window === "monthlySpendUsd";
}

function windowValue(window: ComboQuotaWindow, raw: unknown): number | undefined {
  const max = isSpendWindow(window) ? MAX_SPEND_LIMIT_USD : 100;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= max ? raw : undefined;
}

function withWindows(provider: string, source: Partial<Record<ComboQuotaWindow, unknown>>): ComboQuotaLimitDraft {
  const out: ComboQuotaLimitDraft = { provider };
  for (const window of COMBO_QUOTA_WINDOWS) {
    const value = windowValue(window, source[window]);
    if (value !== undefined) out[window] = value;
  }
  return out;
}

function hasWindow(limit: ComboQuotaLimitDraft): boolean {
  return COMBO_QUOTA_WINDOWS.some(window => limit[window] !== undefined);
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
    const limit = withWindows(provider, row);
    if (hasWindow(limit)) out.push(limit);
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
  const cleaned = withWindows(provider, { ...current, [window]: value });
  const rest = (limits ?? []).filter(limit => limit.provider !== provider);
  return hasWindow(cleaned) ? [...rest, cleaned] : rest;
}

export interface ProviderSpendView { weekUsd: number; monthUsd: number; unpricedRequests: number }

/** `/api/fork/combo-spend` providers map, or null when unavailable. */
export function parseComboSpend(raw: unknown): Record<string, ProviderSpendView> | null {
  const providers = raw && typeof raw === "object" ? (raw as { providers?: unknown }).providers : undefined;
  if (!providers || typeof providers !== "object") return null;
  const out: Record<string, ProviderSpendView> = {};
  for (const [name, value] of Object.entries(providers as Record<string, unknown>)) {
    const row = value as Record<string, unknown> | null;
    if (!row || typeof row.weekUsd !== "number" || typeof row.monthUsd !== "number") continue;
    out[name] = { weekUsd: row.weekUsd, monthUsd: row.monthUsd, unpricedRequests: typeof row.unpricedRequests === "number" ? row.unpricedRequests : 0 };
  }
  return out;
}

export function formatUsd(value: number): string {
  return `$${value < 10 ? value.toFixed(2) : value.toFixed(0)}`;
}
