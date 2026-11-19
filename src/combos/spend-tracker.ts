/**
 * Estimated spend per provider for combo spend limits (fork feature, see FORK.md and
 * `quota-limits.ts`).
 *
 * Built from the usage log with the same checkpointed scan the dashboard's projections use: one
 * full pass, then appended rows only, rebuilding when the file is replaced or shrinks. Each row is
 * priced with `computeEntryCost` (so user price overrides apply) and added to its provider's local
 * calendar day; a combo row adds each attempt to the attempt's own provider. Only the last 62 days
 * are kept, which covers the longest window, a calendar month.
 *
 * Spend is an estimate, not the provider's bill: an unpriced model adds nothing (counted as
 * `unpricedRequests`), and a request is counted once it finishes and is logged.
 */
import { currentUsageLogRevision, usageLogIdentityKey, usageLogRevisionKey, type PersistedUsageEntry, type UsageLogRevision } from "../usage/log";
import { scanUsageLedgerCooperatively, UsageLedgerRebuildRequiredError } from "../usage/ledger-scanner";
import { computeEntryCost } from "../usage/summary";

const KEEP_DAYS = 62;
const DAY_MS = 86_400_000;

interface DayBucket { usd: number; unpriced: number }
type Buckets = Map<string, Map<string, DayBucket>>; // provider -> local day key -> bucket

export interface ProviderSpend {
  weekUsd: number;
  monthUsd: number;
  /** Requests on this provider this month with usage but no price, so they added nothing. */
  unpricedRequests: number;
}

/** Local calendar day key, e.g. 2026-11-18. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Start of the local calendar week (Monday 00:00) containing `now`. */
export function weekStartMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Start of the local calendar month (the 1st, 00:00) containing `now`. */
export function monthStartMs(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function add(buckets: Buckets, provider: string, at: number, usd: number | null): void {
  if (!provider) return;
  let days = buckets.get(provider);
  if (!days) buckets.set(provider, days = new Map());
  const key = localDayKey(at);
  const bucket = days.get(key) ?? { usd: 0, unpriced: 0 };
  if (usd === null) bucket.unpriced += 1;
  else bucket.usd += usd;
  days.set(key, bucket);
}

/** Add one usage row's estimated cost to its provider(s). Exported for tests. */
export function addEntrySpend(buckets: Buckets, entry: PersistedUsageEntry, now = Date.now()): void {
  const at = entry.timestamp;
  if (typeof at !== "number" || at < now - KEEP_DAYS * DAY_MS) return;
  const info = computeEntryCost(entry);
  if (entry.attempts?.length) {
    entry.attempts.forEach((attempt, index) => {
      const estimate = info.attemptEstimates?.[index];
      if (estimate) add(buckets, attempt.provider, at, estimate.cost.total);
      else if (attempt.usage) add(buckets, attempt.provider, at, null);
    });
    return;
  }
  if (info.estimate) add(buckets, entry.provider, at, info.estimate.cost.total);
  else if (entry.usage) add(buckets, entry.provider, at, null);
}

/** Spend for one provider from day buckets. Exported for tests. */
export function spendFromBuckets(buckets: Buckets, provider: string, now = Date.now()): ProviderSpend {
  const days = buckets.get(provider);
  const out: ProviderSpend = { weekUsd: 0, monthUsd: 0, unpricedRequests: 0 };
  if (!days) return out;
  const weekKey = localDayKey(weekStartMs(now));
  const monthKey = localDayKey(monthStartMs(now));
  const todayKey = localDayKey(now);
  for (const [key, bucket] of days) {
    if (key > todayKey) continue;
    if (key >= weekKey) out.weekUsd += bucket.usd;
    if (key >= monthKey) { out.monthUsd += bucket.usd; out.unpricedRequests += bucket.unpriced; }
  }
  return out;
}

function prune(buckets: Buckets, now: number): void {
  const oldest = localDayKey(now - KEEP_DAYS * DAY_MS);
  for (const days of buckets.values()) for (const key of days.keys()) if (key < oldest) days.delete(key);
}

function clone(buckets: Buckets): Buckets {
  return new Map([...buckets].map(([provider, days]) => [provider, new Map([...days].map(([key, b]) => [key, { ...b }]))]));
}

interface Retained {
  buckets: Buckets;
  revision: UsageLogRevision | null;
  identityKey: string;
  revisionKey: string;
  processedThroughBytes: number;
  processedThroughDigest: string;
}

let retained: Retained | null = null;
let inFlight: Promise<void> | null = null;
let overrideForTests: Buckets | null = null;

function retain(buckets: Buckets, scan: Awaited<ReturnType<typeof scanUsageLedgerCooperatively>>): Retained {
  return {
    buckets,
    revision: scan.revision,
    identityKey: usageLogIdentityKey(scan.revision),
    revisionKey: usageLogRevisionKey(scan.revision),
    processedThroughBytes: scan.processedThroughBytes,
    processedThroughDigest: scan.processedThroughDigest,
  };
}

async function rebuild(): Promise<void> {
  const buckets: Buckets = new Map();
  const now = Date.now();
  const scan = await scanUsageLedgerCooperatively({ onEntry: entry => addEntrySpend(buckets, entry, now) });
  retained = retain(buckets, scan);
}

function requiresRebuild(state: Retained, observed: UsageLogRevision | null): boolean {
  if (state.identityKey !== usageLogIdentityKey(observed)) return true;
  if (!state.revision || !observed) return state.revision !== observed;
  if (observed.size < state.revision.size) return true;
  return observed.size === state.revision.size && usageLogRevisionKey(observed) !== state.revisionKey;
}

async function refresh(): Promise<void> {
  const state = retained;
  if (!state) return rebuild();
  const observed = currentUsageLogRevision();
  if (requiresRebuild(state, observed)) return rebuild();
  if (observed && state.revision && observed.size === state.revision.size) return;
  const candidate = clone(state.buckets);
  const now = Date.now();
  try {
    const scan = await scanUsageLedgerCooperatively({
      startAtBytes: state.processedThroughBytes,
      expectedIdentityKey: state.identityKey,
      expectedProcessedThroughDigest: state.processedThroughDigest,
      onEntry: entry => addEntrySpend(candidate, entry, now),
    });
    prune(candidate, now);
    retained = retain(candidate, scan);
  } catch (error) {
    if (retained === state) retained = null;
    if (error instanceof UsageLedgerRebuildRequiredError) return rebuild();
    throw error;
  }
}

/** Bring spend up to date with the usage log. Single-flighted; never throws. */
export function refreshComboSpend(): Promise<void> {
  if (inFlight) return inFlight;
  const flight = refresh().catch(() => { /* keep the previous totals */ }).finally(() => { inFlight = null; });
  inFlight = flight;
  return flight;
}

/** Current estimated spend for `provider`, or null before the first scan finished. */
export function providerSpend(provider: string, now = Date.now()): ProviderSpend | null {
  const buckets = overrideForTests ?? retained?.buckets;
  return buckets ? spendFromBuckets(buckets, provider, now) : null;
}

/** Every provider with spend recorded in the current month. */
export function allProviderSpend(now = Date.now()): Record<string, ProviderSpend> | null {
  const buckets = overrideForTests ?? retained?.buckets;
  if (!buckets) return null;
  const out: Record<string, ProviderSpend> = {};
  for (const provider of buckets.keys()) {
    const spend = spendFromBuckets(buckets, provider, now);
    if (spend.monthUsd > 0 || spend.unpricedRequests > 0) out[provider] = spend;
  }
  return out;
}

/** Test seam: fixed buckets instead of the usage log; null restores. */
export function setComboSpendBucketsForTests(buckets: Buckets | null): void { overrideForTests = buckets; }
export function newSpendBuckets(): Buckets { return new Map(); }
