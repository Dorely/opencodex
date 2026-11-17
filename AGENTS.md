# opencodex (personal fork) agent guidelines

## First read

- This is a personal fork of [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex): a
  Bun-native TypeScript proxy (`ocx`) that lets Codex and Claude Code use many LLM providers.
  The fork exists to carry the owner's own features. Nothing here is meant to go back upstream.
- Read [FORK.md](FORK.md) before substantive work. It lists every place this fork diverges from
  upstream and why; that list is what keeps upstream merges tractable.
- Read [structure/INDEX.md](structure/INDEX.md) before changing a shared subsystem. It maps each
  `src/` area to the docs that own it.
- The nested `AGENTS.md` files (`src/`, `gui/`, `scripts/`, `docs-site/`, `structure/`,
  `.github/`) carry upstream's engineering rules for those areas. Follow their technical rules;
  ignore anything in them about pull requests, maintainers, reviewers, CI dispatch, or releases.
- Upstream's full root guide is kept out of this file on purpose. Read it with
  `git show upstream/dev:AGENTS.md` when a change touches the areas it covers in depth: the
  optional-subsystem (Lab) import boundary, the file-size ratchet, exhaustive unions and counts,
  and the `devlog/` rules.
- [AGENTS_INSTALL.md](AGENTS_INSTALL.md) is for an agent installing or operating opencodex, not
  developing it. Its consent rules (never star repos or spend the user's identity) still bind.
- Verify behavior from code and checks. Docs, devlog notes, and comments describe intent.
- Keep this file focused on durable working practices. Fork divergences belong in FORK.md.

## Fork boundaries

- `origin` is the owner's fork; `upstream` is lidge-jun/opencodex. Never push to `upstream`, and
  never open pull requests, issues, discussions, reviews, or comments on the upstream project.
- No releases: do not tag versions, publish to npm, run `scripts/release.ts`, or bump versions for
  release. Upstream's release machinery is inert here.
- No GitHub Actions: `.github/workflows/` and `.github/actions/` are deleted and must stay deleted.
  Do not add workflows, re-enable CI, or rely on CI to verify anything; local checks are the gate.
- Upstream process rules (PR templates, `enforce-target`, review checklists, `Co-authored-by`
  carry rules, `ci:full` labels, batched `dev` dispatches) do not apply to this fork.

## Repository workflow

- All work happens on `main`, which tracks `origin/main`. Do not create feature or topic branches;
  if you find yourself on another branch, stop and ask. `upstream/dev` is only a merge source.
- Inspect branch, working tree, index, and remotes before starting.
- Start new work from a clean commit. When you find uncommitted work, decide whether it is complete
  and coherent. If it is, verify and commit it on its own before beginning; if it is incomplete or
  its ownership is unclear, ask rather than overwriting it or mixing it with new work.
- Preserve unrelated changes. Do not discard work, rewrite published history, or force-push without
  authorization.
- Finish each feature set with focused, verified commits on `main`, then `git push origin main`
  before reporting it done, and leave a clean working tree. That push is authorized and expected;
  never leave verified work only in the local clone.

## Merging upstream

- Bring in upstream regularly so the fork does not drift, and before starting a large feature:

  ```bash
  git fetch upstream
  git merge --no-ff --no-commit upstream/dev
  git rm -r -q --ignore-unmatch .github/workflows .github/actions
  ```

  The `git rm` drops any workflow upstream added or changed (it also resolves their modify/delete
  conflicts); run it before every merge commit.

- Merge, never rebase: fork commits are published on `origin`, and merges keep every sync point
  visible.
- Root `AGENTS.md` uses the `ours` merge driver (`.gitattributes`), so upstream edits to it are
  dropped silently. Each clone needs `git config merge.ours.driver true` once, or the rule is ignored
  and the file conflicts instead.
- If the merge is clean, run `bun install` (and `bun install` in `gui/` when its lockfile changed),
  `bun run typecheck`, `bun fork/test.ts`, and `bun run structure:check`, then commit the merge and
  push `main`. Upstream CI already ran its full suite on Linux; a failure that also fails on
  upstream's own head, or a new test that reads deleted workflow files, goes in
  `fork/test-exclude.txt` with a reason instead of being fixed here.
- If it conflicts only in files this fork does not own, take upstream's side. If it conflicts with a
  fork divergence listed in FORK.md, stop, `git merge --abort`, and report the conflicting files and
  what each side changed. Do not resolve a conflict against a fork feature without the owner.
- After a merge, re-check that every FORK.md entry still holds; upstream can move or rename the code
  a divergence patched without producing a textual conflict.

## Keeping the diff mergeable

- Prefer new files over edits to upstream files, and small, well-located edits over rewrites. Put a
  fork feature behind an existing seam or registration point when one exists.
- Do not reformat, reorganize, or "clean up" upstream code you are not changing; every touched upstream
  line is a future conflict.
- Record each new divergence in FORK.md in the same commit: which upstream files it touches, why, and
  what a merge must preserve.
- Remove superseded fork code coherently. Do not leave dual paths or compatibility shims unless the
  owner asks for a transition.

## Commands

```bash
bun install && (cd gui && bun install)
bun run typecheck        # strict, no emit
bun fork/test.ts tests/<domain>     # offline tests for an area (or name files)
bun fork/test.ts         # fast offline set, every domain
bun fork/test.ts --all   # include slow files
bun run structure:check  # structure/ doc ownership and invariant gate
bun run privacy:scan
bun run lint:gui
bun run build:gui
```

Bun 1.4.4 is pinned (`testRunnerBun` in `package.json`) and installed globally with
`npm i -g bun@1.4.4`. On Windows, run commands from the repository root in PowerShell or Git Bash.

## Implementation practices

- Runtime is Bun-native strict TypeScript, ES modules, no separate server compile step. Prefer Bun
  and Web-platform APIs over Node-only ones.
- Inspect callers and downstream effects before editing. Use `rg` for file and text discovery.
- `src/router.ts`, `src/server/lifecycle.ts`, and `src/server/responses/core.ts` must never import
  `src/lab/`, directly or transitively; `tests/lab/core-lab-boundary.test.ts` enforces it.
- Changing a `src/` area obliges updating the `structure/` docs that own it. `bun run structure:check`
  fails on stale paths, orphaned invariants, and unclaimed source areas.
- `tests/fixtures/file-size-baseline.json` caps many files at their current length and the caps only
  move down. When a capped file has no headroom, move code or test cases into a sibling file; never
  raise a cap.
- A new test file lands in its domain directory under `tests/` and needs entries in
  `scripts/test-layout/layout.json` (or its domain shard) and a
  `tests/fixtures/test-layout-expected*.json` shard; `tests/test-layout-tooling.test.ts` names the one
  that is missing.
- Use UTF-8 and LF for authored text (`.gitattributes` enforces LF).

## Tests and live providers

- Tests run with no real network I/O at all, loopback included: no servers, sockets, WebSockets, or
  HTTP. `fork/network-guard.ts` (a bunfig preload) makes any such call throw
  `OCX_FORK_NETWORK_BLOCKED` and strips live opt-in variables, provider keys, and proxy variables.
  There is no switch to turn it off.
- Run tests through `bun fork/test.ts`, never `bun run test` or `bun run test:changed`. The upstream
  runners include the roughly 1,400 server-backed files, which fail under the guard. The fork runner
  skips those, the files in `fork/test-exclude.txt`, and (without `--all`) the slow files in
  `fork/test-slow.txt`.
- New tests are offline unit tests: stub `fetch`, call handlers directly, and use fixtures. Do not
  add tests that start a server or open a socket, and do not re-enable live tests. A live check of a
  provider or of the proxy happens only when the owner asks for it, by hand, against a dev proxy.
- During implementation run `bun fork/test.ts <paths>` for the areas you touched, plus
  `bun run typecheck`. Before finishing a change that crosses subsystems, run `bun fork/test.ts`.
  Run `--all` when you touch an area that has slow files.
- If a test file starts failing with `OCX_FORK_NETWORK_BLOCKED`, add it to `fork/test-exclude.txt`
  with a reason. After an upstream merge, regenerate the slow list with `bun fork/test.ts --timings`.
- `bun test` loads the guard only when it runs from the repository root. Always run tests from
  there. Concurrent test runs queue on a shared lock, so run one at a time.
- For logging, credential, account, or fixture changes also run `bun run privacy:scan`.
- Never describe an unrun suite as passing. Report failing tests with their output.

## The owner's live install

- The owner runs a real opencodex install on this machine (`ocx`, default port 10100, home under
  `~/.opencodex`). Never stop, restart, reconfigure, or write to it, and never point a dev run or test
  at its home or port.
- Run a dev proxy with its own home and port, for example
  `OPENCODEX_HOME=<scratch dir> bun run src/cli/index.ts start --port <free port>`, and stop it after
  validation. Do not install services, shims, or scheduled tasks from the dev tree.
- Tests sandbox `HOME`, `OPENCODEX_HOME`, and `CODEX_HOME` through `tests/preload.ts`.
- This shell can carry `HTTP_PROXY`/`HTTPS_PROXY` pointing at the live install. The test guard strips
  them. Unset them for any other dev command that should not route through the owner's proxy.

## Credentials

- Never log, print, commit, or persist API keys, OAuth tokens, or account identifiers. Never copy real
  auth files, sibling-app databases, or credentials into the repository or fixtures.
- Authentication, OAuth, token, management API, and CORS changes are security-boundary changes: trace
  them end to end and add focused regression tests.
- Security notes about unfixed weaknesses go in `.tmp/` (gitignored) or scratch space, never in a
  tracked directory.

## Documentation and verification

- Keep FORK.md current with every divergence. Update `docs-site/` only when a fork change alters
  user-visible behavior the owner relies on.
- Record what was actually run when reporting work. Do not claim provider, login, or platform
  behavior from compilation alone.
- Plan cleanup before starting temporary servers or helpers and stop those you start. Never terminate
  a process you did not start.
