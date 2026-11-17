/**
 * Per-combo provider quota limits (fork feature, see FORK.md).
 *
 * A combo may cap how much of a provider's rolling quota it is allowed to spend:
 *
 *   "combos": { "Expensive": { "targets": [...],
 *     "quotaLimits": [{ "provider": "commandcode", "fiveHourPercent": 50, "weeklyPercent": 50 }] } }
 *
 * While the provider's cached 5-hour or weekly usage is above its limit, that combo skips every
 * target on the provider; other combos and direct calls are unaffected. When no target is left the
 * combo answers `combo_unavailable` with the reason "quota limit".
 *
 * Evidence is the provider quota cache only; this never probes upstream on a request. Unknown or
 * stale usage (no report in the last 30 minutes, or a window whose reset has passed) does not block:
 * `combo-quota-limit-refresher.ts` keeps the cache warm while any combo declares a limit.
 *
 * This module stays free of the quota cache because `types.ts` (and so the config facade) imports
 * it; the cache-reading check lives in `quota-limit-check.ts`.
 */
import type { OcxConfig } from "../types";

export interface OcxComboQuotaLimit {
  /** Configured provider name whose targets this limit gates. */
  provider: string;
  /** Skip the provider's targets while 5-hour usage is above this percent (0..100). */
  fiveHourPercent?: number;
  /** Skip the provider's targets while weekly usage is above this percent (0..100). */
  weeklyPercent?: number;
}

/** The limit attached to one normalized target. */
export interface ComboTargetQuotaLimit {
  fiveHourPercent?: number;
  weeklyPercent?: number;
}

const WINDOW_FIELDS = ["fiveHourPercent", "weeklyPercent"] as const;

function validPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** Validation messages for a raw `quotaLimits` value, keyed by path below `quotaLimits`. */
export function comboQuotaLimitIssues(raw: unknown): { path: (string | number)[]; message: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [{ path: [], message: "quotaLimits must be an array" }];
  const issues: { path: (string | number)[]; message: string }[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ path: [index], message: "quota limit must be an object" });
      return;
    }
    const row = entry as Record<string, unknown>;
    const provider = typeof row.provider === "string" ? row.provider.trim() : "";
    if (!provider) issues.push({ path: [index, "provider"], message: "quota limit provider must be a non-empty provider name" });
    else if (seen.has(provider)) issues.push({ path: [index, "provider"], message: `quota limit for provider "${provider}" is declared twice` });
    else seen.add(provider);
    let windows = 0;
    for (const field of WINDOW_FIELDS) {
      if (row[field] === undefined || row[field] === null) continue;
      windows++;
      if (!validPercent(row[field])) issues.push({ path: [index, field], message: `${field} must be a number from 0 to 100` });
    }
    if (windows === 0) issues.push({ path: [index], message: "quota limit needs fiveHourPercent or weeklyPercent" });
    for (const key of Object.keys(row)) {
      if (key !== "provider" && !(WINDOW_FIELDS as readonly string[]).includes(key)) {
        issues.push({ path: [index, key], message: `unknown quota limit field "${key}"` });
      }
    }
  });
  return issues;
}

/** Valid limits by provider name; invalid rows are dropped (load-time validation reports them). */
export function normalizeComboQuotaLimits(raw: unknown): Map<string, ComboTargetQuotaLimit> {
  const out = new Map<string, ComboTargetQuotaLimit>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const provider = typeof row.provider === "string" ? row.provider.trim() : "";
    if (!provider || out.has(provider)) continue;
    const limit: ComboTargetQuotaLimit = {};
    for (const field of WINDOW_FIELDS) if (validPercent(row[field])) limit[field] = row[field] as number;
    if (Object.keys(limit).length > 0) out.set(provider, limit);
  }
  return out;
}

/** The stored (combo-level) form of normalized limits, sorted by provider. */
export function comboQuotaLimitList(limits: Map<string, ComboTargetQuotaLimit>): OcxComboQuotaLimit[] {
  return [...limits].sort(([a], [b]) => a.localeCompare(b)).map(([provider, limit]) => ({ provider, ...limit }));
}

/** Whether any configured combo declares a quota limit. */
export function comboQuotaLimitsConfigured(config: Pick<OcxConfig, "combos"> | null | undefined): boolean {
  return Object.values(config?.combos ?? {}).some(combo =>
    normalizeComboQuotaLimits((combo as { quotaLimits?: unknown } | undefined)?.quotaLimits).size > 0);
}
