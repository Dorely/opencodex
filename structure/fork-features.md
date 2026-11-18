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
operator configured for Claude Code (`claudeCode.model`, `smallFastModel`, `tierModels`, matched
raw or with `slugEquals`, ignoring a `[1m]` marker) and any request an
ocx-route pin rewrites are exempt too: `claude-messages.ts` skips its own check and passes
`hiddenModelExempt` so `request-prepare.ts` skips both of its checks. Codex's hard-coded helper and memory
ids (`SHADOW_SOURCE_MODEL_OPTIONS`, plus configured `shadowCallIntercept.sourceModels`) are never
refused when requested bare, because Codex sends them without the user picking them.

Matching follows the catalog's own rules: an exact selector, `provider/model` in raw or encoded form
(`slugEquals`), an account-qualified native id, a bare native id for the canonical OpenAI provider,
and every selector `comboDisabledModelSelectors` lists for a combo.

A hidden model or combo also leaves the subagent roster. `isHiddenSelector` matches a stored
selector without routing it (exact entry, raw or encoded `provider/model`, or a hidden combo by any
selector); `subagentSelectableModels` stops keeping a hidden saved slot in the dashboard's roster
list, and `buildClaudeAgentDefs` writes no `ocx-*` agent for one. A combo in the roster
(`combo/expensive`) gets an agent like a model (`ocx-expensive`, model alias resolving to the combo).

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
time has passed never exclude. Reset times go through `epochMillis` first, because the Codex
(`chatgpt:wham`) report carries epoch seconds while most reports carry milliseconds. Because upstream refreshes quota only for the dashboard,
`src/combos/combo-quota-limit-refresher.ts` (started and stopped by
`src/server/index/optional-listeners.ts`, following the live config) calls the dashboard's
non-forced `fetchProviderQuotaReports` every five minutes while any combo declares a limit, and is
idle otherwise.

The dashboard's combo detail panel edits the limits (`gui/src/fork/ComboQuotaLimitsField.tsx`): one
row per distinct target provider with 5-hour and weekly percent inputs, blank meaning no cutoff. The
save body carries `quotaLimits` only when the combo has one, filtered to providers it still targets.
The management combo save stores the combo-level list, never the per-target `quotaLimit`, keeps a
stored list when the request omits the field, and clears it on an empty array.

## Modality probe

`POST /api/fork/modality-probes` with `{ provider, model, modality: "image" }` tests whether a routed
model reads image input (`src/server/management/fork-modality-probe.ts`). It renders a PNG of a random
five-digit number (`src/vision/fork-probe-image.ts`), sends it to `provider/model` through the
proxy's own `/v1/chat/completions` on loopback with a prompt to reply with the digits, and passes
only when a digit run in the reply equals the number. A pass on a model that does not already resolve
to image writes `modelCapabilities[model].inputModalities` (its current modalities, text kept, plus
image), clears the provider's model cache and converges the Codex catalog. A failure writes nothing.
Every result is recorded in `<config dir>/fork/modality-probes.json`, which `GET` returns.

The request carries `x-opencodex-fork-modality-probe` with the process's internal-call capability;
`src/server/chat-completions.ts` then skips the hidden-model refusal for it, so a hidden provider model
can be probed. A model declared text-only (a Vision Sidecar consumer) is refused with 409, because the
sidecar would read the image for it. The native `openai` lane and combos cannot be probed.

The combo detail panel lists targets whose row does not declare image input
(`gui/src/fork/ComboModalityProbeField.tsx`) with a "Test image input" button and the last result;
a pass that declared image reloads the page's model rows, so the image input switch can turn on.
