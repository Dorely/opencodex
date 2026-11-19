/**
 * Keeps the provider quota cache warm while a combo declares `quotaLimits` (fork feature, see
 * FORK.md and `quota-limits.ts`).
 *
 * Upstream refreshes provider quota only when the dashboard asks for it (or the opt-in reset
 * poller runs), and routing ignores reports older than 30 minutes. A quota limit evaluated against
 * that cache would silently stop applying whenever the dashboard is closed. While the live config
 * has any combo with a limit, this refreshes the reports every few minutes through the same
 * non-forced, cached, in-flight-joined read the dashboard uses, so it adds no probes beyond what an
 * open dashboard would cost. With no limits configured it is idle.
 *
 * While any combo declares a spend limit it also brings the spend tracker up to date with the usage
 * log every minute (an appended-rows read after the first full pass).
 */
import { registerLiveConfigObserver } from "../lib/state-store-registrations";
import { comboQuotaLimitsConfigured, comboSpendLimitsConfigured } from "./quota-limits";
import { refreshComboSpend } from "./spend-tracker";
import type { OcxConfig } from "../types";

export const COMBO_QUOTA_REFRESH_INTERVAL_MS = 5 * 60_000;
export const COMBO_SPEND_REFRESH_INTERVAL_MS = 60_000;

type Refresh = (config: OcxConfig) => Promise<unknown>;

const defaultRefresh: Refresh = async config => {
  const { fetchProviderQuotaReports } = await import("../providers/quota");
  return fetchProviderQuotaReports(config, false);
};

let refresh: Refresh = defaultRefresh;
let timer: ReturnType<typeof setInterval> | null = null;
let spendTimer: ReturnType<typeof setInterval> | null = null;
let spendRefresh: () => Promise<void> = refreshComboSpend;

function spendTick(): void {
  if (liveConfig && comboSpendLimitsConfigured(liveConfig)) void spendRefresh();
}
let liveConfig: OcxConfig | null = null;
let inFlight = false;

function tick(): void {
  const config = liveConfig;
  if (!config || inFlight || !comboQuotaLimitsConfigured(config)) return;
  inFlight = true;
  void refresh(config).catch(() => { /* a failed probe leaves the previous evidence to age out */ })
    .finally(() => { inFlight = false; });
}

/** Converge with a live config: run while any combo declares a limit, idle otherwise. Never throws. */
export function reconcileComboQuotaLimitRefresher(config: OcxConfig): void {
  liveConfig = config;
  const wanted = comboQuotaLimitsConfigured(config);
  if (wanted && !timer) {
    timer = setInterval(tick, COMBO_QUOTA_REFRESH_INTERVAL_MS);
    timer.unref?.();
    tick();
  } else if (!wanted && timer) {
    clearInterval(timer);
    timer = null;
  }
  const spendWanted = comboSpendLimitsConfigured(config);
  if (spendWanted && !spendTimer) {
    spendTimer = setInterval(spendTick, COMBO_SPEND_REFRESH_INTERVAL_MS);
    spendTimer.unref?.();
    spendTick();
  } else if (!spendWanted && spendTimer) {
    clearInterval(spendTimer);
    spendTimer = null;
  }
}

/** Started once the server is serving; the returned stop unregisters and clears the timer. */
export function startComboQuotaLimitRefresher(config: OcxConfig): () => void {
  const unregister = registerLiveConfigObserver("combo-quota-limit-refresher", reconcileComboQuotaLimitRefresher);
  reconcileComboQuotaLimitRefresher(config);
  return () => {
    unregister();
    if (timer) clearInterval(timer);
    timer = null;
    if (spendTimer) clearInterval(spendTimer);
    spendTimer = null;
    liveConfig = null;
  };
}

export function comboQuotaLimitRefresherRunning(): boolean { return timer !== null; }

/** Test seam: replace the upstream read; pass undefined to restore it. */
export function setComboQuotaRefreshForTests(fn: Refresh | undefined): void { refresh = fn ?? defaultRefresh; }

export function comboSpendRefresherRunning(): boolean { return spendTimer !== null; }

/** Test seam: replace the spend refresh; pass undefined to restore it. */
export function setComboSpendRefreshForTests(fn: (() => Promise<void>) | undefined): void { spendRefresh = fn ?? refreshComboSpend; }
