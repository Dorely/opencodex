# Fork features

Runtime behavior this personal fork adds on top of upstream. [FORK.md](../FORK.md) lists the files
each feature touches and what an upstream merge must preserve; this page describes how they work.

## Hidden model refusal

Upstream's `disabledModels` hides a model from discovery only (see [catalog](catalog.md)). In this
fork `src/routing/hidden-models.ts` also refuses a request whose client-chosen selector names,
aliases or resolves to a hidden model, or names a hidden combo. The check runs at the request entry
points, never inside `src/router.ts`:

- `src/server/responses/request-prepare.ts` checks the main inbound route (not a memory phase,
  shadow-call target, hard-lock fallback, compaction route or concrete combo/policy child), and checks
  a combo selector before combo dispatch. Both answer 404 `invalid_request_error` with
  `Model "<id>" is hidden. Unhide it in opencodex to call it.`
- `src/server/chat-completions.ts` and `src/server/claude-messages.ts` run the same check on their
  pre-route, so a hidden model never takes a native lane and falls through to the Responses refusal.

Operator-chosen destinations stay routable: combo targets, policy picks, blocked-model redirect
targets, fallback chains, subagent fallbacks and compaction. On the Claude Messages lane, a model the
operator configured for Claude Code (`claudeCode.model`, `smallFastModel`, `tierModels`,
`subagentModels`, matched raw or with `slugEquals`, ignoring a `[1m]` marker) and any request an
ocx-route pin rewrites are exempt too: `claude-messages.ts` skips its own check and passes
`hiddenModelExempt` so `request-prepare.ts` skips both of its checks. Codex's hard-coded helper and memory
ids (`SHADOW_SOURCE_MODEL_OPTIONS`, plus configured `shadowCallIntercept.sourceModels`) are never
refused when requested bare, because Codex sends them without the user picking them.

Matching follows the catalog's own rules: an exact selector, `provider/model` in raw or encoded form
(`slugEquals`), an account-qualified native id, a bare native id for the canonical OpenAI provider,
and every selector `comboDisabledModelSelectors` lists for a combo.

## Combo quota limits

A combo may declare `quotaLimits`, a list of `{ provider, fiveHourPercent?, weeklyPercent? }`
(each 0..100, at least one window, one entry per provider), validated by `comboConfigIssues` through
`comboQuotaLimitIssues` in `src/combos/quota-limits.ts`, which must not import the quota cache
(the config facade loads it); the cache-reading check is `src/combos/quota-limit-check.ts`. `normalizeComboConfig` attaches the entry to
each of that provider's targets as `quotaLimit` and keeps the sorted list as the combo's `quotaLimits`.

`providerExclusionReason` in `src/combos/resolve.ts` excludes a target whose provider's usage is
strictly above a limit, with the reason `quota limit`; `combo_unavailable` diagnostics classify it as
quota, and failover logs it as `quota_exhausted`. Only that combo is affected: other combos and
direct calls to the same provider keep routing.

Evidence is `getCachedProviderRoutingQuota`, falling back to the provider's cached report
(`getCachedProviderQuota`). Unknown usage, a report older than 30 minutes, and a window whose reset
time has passed never exclude. Because upstream refreshes quota only for the dashboard,
`src/combos/combo-quota-limit-refresher.ts` (started and stopped by
`src/server/index/optional-listeners.ts`, following the live config) calls the dashboard's
non-forced `fetchProviderQuotaReports` every five minutes while any combo declares a limit, and is
idle otherwise.

The dashboard's combo detail panel edits the limits (`gui/src/fork/ComboQuotaLimitsField.tsx`): one
row per distinct target provider with 5-hour and weekly percent inputs, blank meaning no cutoff. The
save body carries `quotaLimits` only when the combo has one, filtered to providers it still targets.
The management combo save stores the combo-level list, never the per-target `quotaLimit`, keeps a
stored list when the request omits the field, and clears it on an empty array.
