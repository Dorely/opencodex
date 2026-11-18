/** Cache-reading half of per-combo quota limits (fork feature); see `quota-limits.ts`. */
import { getCachedProviderQuota, getCachedProviderRoutingQuota } from "../providers/quota-routing-cache";
import type { ProviderQuota } from "../providers/quota-types";
import { epochMillis } from "../providers/quota-wire";
import type { OcxConfig } from "../types";
import type { ComboTargetQuotaLimit } from "./quota-limits";

function windowAbove(percent: number | undefined, resetAt: number | undefined, limit: number | undefined, now: number): boolean {
  if (limit === undefined || typeof percent !== "number" || !Number.isFinite(percent)) return false;
  // A window whose reset already passed no longer describes current usage. Reports mix units:
  // the Codex (chatgpt:wham) report carries epoch seconds, most others epoch milliseconds.
  const resetMs = typeof resetAt === "number" ? epochMillis(resetAt) : undefined;
  if (resetMs !== undefined && resetMs <= now) return false;
  return percent > limit;
}

/** Credential-bound routing evidence first, else the provider's dashboard report. */
function providerQuota(config: OcxConfig, provider: string, now: number): ProviderQuota | null {
  const row = Object.hasOwn(config.providers, provider) ? config.providers[provider] : undefined;
  return getCachedProviderRoutingQuota(provider, row, now) ?? getCachedProviderQuota(provider, now);
}

/** True when the target's provider is above a limit its combo set. */
export function comboTargetQuotaLimitExceeded(
  config: OcxConfig,
  target: { provider: string; quotaLimit?: ComboTargetQuotaLimit },
  now = Date.now(),
): boolean {
  const limit = target.quotaLimit;
  if (!limit) return false;
  const quota = providerQuota(config, target.provider, now);
  if (!quota) return false;
  return windowAbove(quota.fiveHourPercent, quota.fiveHourResetAt, limit.fiveHourPercent, now)
    || windowAbove(quota.weeklyPercent, quota.weeklyResetAt, limit.weeklyPercent, now);
}
