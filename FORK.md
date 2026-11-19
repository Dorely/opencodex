# Fork divergences

This fork tracks [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) `dev` and carries the
owner's own changes on top. Every place it differs from upstream is listed here so an upstream merge
can be checked against it. Add an entry in the same commit that introduces a divergence, and remove
it when the divergence goes away.

Each entry names the files touched, why, and what a merge must preserve.

## Remotes and merging

- `origin` = `Dorely/opencodex` (this fork), `upstream` = `lidge-jun/opencodex`.
- The fork's working branch is `main` (upstream's is `dev`); `upstream/dev` is merged into `main`.
- Sync with `git fetch upstream && git merge --no-ff --no-commit upstream/dev`, then
  `git rm -r -q --ignore-unmatch .github/workflows .github/actions`; the full procedure is in
  [AGENTS.md](AGENTS.md) under "Merging upstream".
- One-time per clone: `git config merge.ours.driver true` (activates the `AGENTS.md` rule below).

## Agent guidance

- **Files:** `AGENTS.md` (rewritten), `CLAUDE.md` (new, imports `AGENTS.md`), `.gitattributes`
  (one `merge=ours` line), `FORK.md` (this file).
- **Why:** the root guide is written for this fork's workflow instead of upstream's contributor and
  maintainer process. Upstream's version stays readable with `git show upstream/dev:AGENTS.md`.
- **Merge must preserve:** our `AGENTS.md`. The `ours` driver keeps it automatically. Two tests read
  it: `tests/server/startup-prompt.test.ts` requires it to mention `AGENTS_INSTALL.md`, and
  `bun run structure:check` requires a `## Commands` heading because `structure/ops/docs-and-release.md`
  links to `AGENTS.md#commands`. If upstream adds another such dependency, adjust our file rather than
  taking theirs.

## GitHub Actions removed

- **Files:** `.github/workflows/` and `.github/actions/` (deleted); `structure/manifest.json`
  (`absentPaths` entries for both); `scripts/structure-ssot.ts` (one line: an `absentPaths` entry
  ending in `/` also covers every path under it, so upstream docs that name workflow files pass);
  `fork/test-exclude.txt` (the test files that read workflow files).
- **Why:** no CI, release, or bot automation runs for this fork; local checks are the gate. The rest
  of `.github/` (issue and PR templates, `CODEOWNERS`, `scripts/`, nested `AGENTS.md`) is inert and
  left in place to keep merges small.
- **Merge must preserve:** run `git rm -r -q --ignore-unmatch .github/workflows .github/actions` before
  each upstream merge commit; it removes new workflows and resolves modify/delete conflicts. Exclude
  any new test that fails because it reads a workflow file.

## Offline-only test suite

- **Files:** `fork/network-guard.ts`, `fork/test.ts`, `fork/test-exclude.txt`, `fork/test-slow.txt`
  (all new), `bunfig.toml` (second `preload` entry).
- **Why:** upstream's suite starts about 1,400 files' worth of loopback servers, and its offline
  status is convention only. This fork runs no real network I/O in tests at all, loopback included,
  and the full upstream run was far too slow on this Windows host (about 100 of 3,310 files in
  11 minutes).
- **Guard** (`fork/network-guard.ts`, preloaded by every `bun test` from the repository root, no
  off switch):
  - removes live opt-in variables (`NOUS_LIVE_TEST`, `OCX_ALLOW_LIVE_OPENAI_SMOKE`,
    `CODEBUDDY_LIVE_*`, `OPENCODEX_CURSOR_TEST_*`, `STEERING_*`, `OCX_TEST_OPENCODE_BIN`,
    `OCX_TEST_KILO_BIN`, `OCX_LINK_WS_RSS_*`, `OCX_OPENSSH_ROUTE_FIXTURE`), provider credentials
    (`*_API_KEY`, GitHub/HF/Anthropic/AWS tokens), and `HTTP(S)_PROXY`-style variables. The owner's
    shell points those proxy variables at the live install, which would otherwise forward test traffic;
  - makes `fetch` (http/https/ws URLs), `WebSocket`, `Bun.serve/listen/connect/udpSocket`, and the
    default-export `node:net/http/https/tls` entry points throw `OCX_FORK_NETWORK_BLOCKED`.
    Named imports such as `import { createServer } from "node:net"` cannot be patched; the runner's
    scan skips those files instead.
- **Runner** (`bun fork/test.ts`): skips any test file that, directly or through files it reaches
  under `tests/`, starts a server, opens a socket or WebSocket, names a loopback URL, or launches a
  CLI on a port. It also skips `fork/test-exclude.txt` (network the scan misses, Lab live-probe
  suites, and files that fail on this Windows host) and, unless `--all`, the generated
  `fork/test-slow.txt`. Runs in batches of 150 through upstream's `scripts/test.ts` wrapper (lock, sandbox, `--isolate --parallel=4`).
- **Not covered:** child processes a test spawns do not load the guard; the scan catches the common
  shapes (`--port`, helper scripts that serve).
- **Merge must preserve:** the guard path in `bunfig.toml`'s `preload` list. After a merge run
  `bun fork/test.ts --timings` to refresh the slow list, and add any new guard-blocked or live file to
  `fork/test-exclude.txt`. `bun run test` and `bun run test:changed` are upstream's runners and fail
  under the guard; they are not part of this fork's workflow.
- **Manual live scripts left in place** (not tests, never run by `bun test`, each requires explicit
  flags or env, and none is run without the owner asking): `scripts/openai-provider-option-runtime-smoke.ts`,
  `scripts/steering-smoke.ts`, `scripts/codebuddy-live-acceptance.ts`,
  `scripts/verify-loopback-direct-spawn.mjs`.

## Hidden model refusal

- **Files:** `src/routing/hidden-models.ts` (new); one guarded call each in
  `src/server/responses/request-prepare.ts` (after `onRequestBodyParsed` captures the client
  selector, before combo dispatch, and after `resolveRoute`), `src/server/chat-completions.ts` and
  `src/server/claude-messages.ts` (right after the pre-route `routeModel`). How it behaves:
  [structure/fork-features.md](structure/fork-features.md#hidden-model-refusal).
- **Why:** upstream's `disabledModels` only hides models from discovery; a client could still call
  one by name. Here the client-chosen selector is refused with 404 `Model "<id>" is hidden`.
- **Merge must preserve:** the checks run at the entry points, never in `src/router.ts`, so combo
  targets, policy picks, redirects, fallbacks, compaction, shadow/memory routes and Codex helper ids
  keep routing. If upstream renames `resolveRoute`, `onRequestBodyParsed`, the combo dispatch in
  `request-prepare.ts`, or the native-lane pre-route, move the calls with it.
  `structure/catalog.md` carries a one-line pointer replacing upstream's "selecting it is not refused".
- **Claude Code operator models:** `claude-messages.ts` sets `hiddenModelExempt` when an ocx-route pin
  applies or the requested model is one the operator configured for Claude Code
  (`claudeCode.model`, `smallFastModel`, `tierModels`; `isClaudeOperatorModel`),
  and passes it to `handleResponses` through `src/server/responses/core-options.ts`, which skips both
  checks in `request-prepare.ts`. Claude Code sends those ids as-is even when they are hidden from the
  picker, so without this every tier request would 404.
- **Hidden models leave the subagent roster:** `isHiddenSelector` (in `hidden-models.ts`) is used by
  `src/codex/subagent-selectable-models.ts` (a hidden saved roster slot is no longer kept in the
  dashboard's roster list, so the next roster save drops it) and `src/claude/agents-inject.ts`
  (`buildClaudeAgentDefs` writes no `ocx-*` agent for a hidden slot). Upstream keeps hidden saved
  slots on purpose to avoid truncating a roster; this fork treats hiding as removal. Combos were
  already roster entries (`combo/<id>` gives an `ocx-<id>` agent). If upstream reworks either
  function, keep both filters.

## Combo quota limits

- **Files:** `src/combos/quota-limits.ts`, `src/combos/quota-limit-check.ts` and
  `src/combos/combo-quota-limit-refresher.ts` (new; `quota-limits.ts` must stay cache-free or it
  creates an import cycle through `src/config.ts`);
  `src/combos/types.ts` (validation and per-target `quotaLimit`), `src/combos/resolve.ts`
  (`"quota limit"` exclusion reason), `src/types/config.ts` (`OcxComboConfig.quotaLimits`),
  `src/server/management/combo-routes.ts` (PUT keeps a stored `quotaLimits` when omitted),
  `src/server/index/optional-listeners.ts` (refresher start/stop). Spend limits: `src/combos/spend-tracker.ts`
  and `src/server/management/fork-combo-spend.ts` (new), the `"spend limit"` reason in `resolve.ts`, one
  dispatch line in `src/server/management-api.ts` and a `gui-only` entry in `route-registry.ts`. Dashboard editor:
  `gui/src/fork/combo-quota-limits.ts` and `gui/src/fork/ComboQuotaLimitsField.tsx` (new, English-only
  copy so the eleven locale catalogs stay untouched), plus small edits in
  `gui/src/combo-workspace-data.ts` (parse, compare, and send a sparse `quotaLimits`) and
  `gui/src/components/combo-workspace-detail-panel.tsx` (renders the field, baseline sync key).
  `normalizeComboConfig` also keeps the combo-level list (`quotaLimits`) so the PUT route stores it
  there; the route strips the per-target `quotaLimit` before storing. How it behaves:
  [structure/fork-features.md](structure/fork-features.md#combo-quota-limits).
- **Why:** lets a combo stop using a provider once its 5-hour or weekly usage passes a percent,
  for example `"quotaLimits": [{ "provider": "commandcode", "fiveHourPercent": 50, "weeklyPercent": 50 }]`,
  or once its estimated spend this calendar week or month reaches a dollar amount, for providers with no
  readable quota (an Anthropic API key): `{ "provider": "anthropic-apikey", "monthlySpendUsd": 80 }`.
- **Merge must preserve:** the exclusion lives in `providerExclusionReason`; unknown, stale or reset
  usage fails open, with reset times normalized by `epochMillis` (the Codex report uses epoch
  seconds; comparing those to a millisecond clock made every Codex window look already reset); the refresher runs only while a combo declares a limit. The dashboard sends
  `quotaLimits` only when the combo has one, because upstream GUI tests assert the exact save body; if
  upstream reshapes the combo editor or its save body, move the field and the sparse send with it.

## Modality probe

- **Files:** `src/server/management/fork-modality-probe.ts` and `src/vision/fork-probe-image.ts`
  (new); `src/server/management-api.ts` (one dispatch line), `src/server/management/route-registry.ts`
  (two `gui-only` entries for `/api/fork/modality-probes`), `src/routing/hidden-models.ts`
  (`MODALITY_PROBE_HEADER`), `src/server/chat-completions.ts` (reads that header with
  `isInternalCallCapability`, skips `assertModelNotHidden`, passes `hiddenModelExempt`). Dashboard:
  `gui/src/fork/ComboModalityProbeField.tsx` and `gui/src/fork/modality-probe-candidates.ts` (new),
  rendered by `gui/src/components/combo-workspace-detail-panel.tsx`, which gains an
  `onModelsChanged` prop that `gui/src/components/ComboWorkspace.tsx` wires to its refresh. How it
  behaves: [structure/fork-features.md](structure/fork-features.md#modality-probe).
- **Why:** a provider catalog can leave a model's image input undeclared (Command Code's
  `google/gemini-4-carbon`), which blocks image input on every combo that uses it. The probe proves
  the model reads images and then declares it.
- **Merge must preserve:** a pass writes only `modelCapabilities[model].inputModalities`, the field
  upstream's Model settings dialog edits; the probe goes through `/v1/chat/completions` on loopback so
  the real adapter builds the wire; the hidden-model exemption needs the process capability, never the
  bare header. If upstream moves the chat surface's hidden check or its `advisorInternal` capability
  read, move the probe check with them.

## Passthrough error log

- **Files:** `src/server/fork-passthrough-error-log.ts` (new); `src/server/claude-messages.ts` (one import and
  one call in `anthropicNativePassthrough`, in the non-stream `upstream.status >= 400` branch). How it
  behaves: [structure/fork-features.md](structure/fork-features.md#passthrough-error-log).
- **Why:** upstream keeps only a closed error type for a failed Anthropic passthrough, so an intermittent
  404 on a Claude model could not be explained from the logs. The log showed the 404s were Anthropic's
  `thread_not_found` (message-threads beta), which upstream's rebuilt error body drops; Claude Code then
  shows "Model isn't available" instead of replaying the conversation. `withRelayedErrorDetails` (same
  file, wrapped around `ownedAnthropicErrorPayload` in the passthrough) puts that code and Anthropic's
  message back, for a closed set of codes.
- **Merge must preserve:** the call sits where the upstream error text is in hand, before `finalize`.
  It records no credential and no request body, and it never throws.

## Fork tests, layout and docs

- **Files:** `tests/routing/fork-*.test.ts`, `tests/gui/fork-*.test.ts`,
  `scripts/test-layout/layout-fork.json` (new, listed in
  `explicitShards` of `scripts/test-layout/layout.json`), appended entries at the end of
  `tests/fixtures/test-layout-expected.json`, `structure/fork-features.md` plus its
  `structure/manifest.json` entry and regenerated `structure/INDEX.md`, one-line pointer in
  `structure/runtime.md`.
- **Merge must preserve:** on conflicts in the expected-layout fixture, `manifest.json` or `INDEX.md`,
  take upstream's side and re-append the fork entries (`bun run structure:index` regenerates INDEX).
