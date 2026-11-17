# Fork divergences

This fork tracks [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) `dev` and carries the
owner's own changes on top. Every place it differs from upstream is listed here so an upstream merge
can be checked against it. Add an entry in the same commit that introduces a divergence, and remove
it when the divergence goes away.

Each entry names the files touched, why, and what a merge must preserve.

## Remotes and merging

- `origin` = `Dorely/opencodex` (this fork), `upstream` = `lidge-jun/opencodex`.
- Sync with `git fetch upstream && git merge --no-ff upstream/dev`; the full procedure is in
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
