#!/usr/bin/env bun
/**
 * Fork test runner (see FORK.md): runs the offline subset of tests/.
 *
 * A test file is skipped when it, or any file it reaches under tests/ (relative imports, or
 * helperPath()/fixturePath() targets it spawns or preloads), matches a network pattern: servers,
 * sockets, WebSockets, loopback URLs, or a CLI started on a port. Files listed in
 * fork/test-exclude.txt are skipped too; that list holds what the scan misses (usually a test whose
 * server is started inside src/) and files that fail on the dev host. fork/network-guard.ts makes any
 * remaining real network call fail.
 *
 * Files listed in fork/test-slow.txt (over SLOW_SECONDS on their own) are skipped by default and
 * run with --all. `--timings` runs everything selected, including slow files, and rewrites that list.
 *
 *   bun fork/test.ts                     run the fast offline set
 *   bun fork/test.ts tests/routing ...   only files under these paths (or these files)
 *   bun fork/test.ts --all               include slow files
 *   bun fork/test.ts --timings           run fast + slow, then regenerate fork/test-slow.txt
 *   bun fork/test.ts --list              print the selected files and exit
 *   bun fork/test.ts --excluded          print skipped files with the reason and exit
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TESTS = join(ROOT, "tests");
const BATCH_SIZE = 150;
// Each batch goes through upstream's wrapper, which owns the user-level test lock, the sandboxed
// home, and `--isolate --parallel=4`. Bare parallel `bun test` workers race for that lock on Windows.
const RUNNER_ARGS = ["scripts/test.ts", "--timeout=15000"];
const SLOW_SECONDS = 3;
const SLOW_LIST = join(ROOT, "fork", "test-slow.txt");

const NETWORK_PATTERNS: [RegExp, string][] = [
  [/\bBun\.(serve|listen|connect|udpSocket)\b/, "Bun server/socket"],
  [/import\s*\{[^}]*\bserve\b[^}]*\}\s*from\s*["']bun["']/, "Bun serve import"],
  [/\bstartServer\b/, "starts the proxy server"],
  [/\bcreateServer\b/, "createServer"],
  [/\.listen\(/, "listen()"],
  [/\bnew WebSocket\b|\bWebSocketServer\b/, "WebSocket"],
  [/["']node:(net|http|https|http2|tls|dgram)["']/, "node network module"],
  [/\b(https?|wss?):\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/, "loopback URL"],
  [/["']--port["']/, "starts a CLI on a port"],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

const posix = (p: string) => p.split("\\").join("/");
const rel = (p: string) => posix(relative(ROOT, p));

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT_RE = /(?:from\s*|import\s*\(\s*|import\s+|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const PATH_HELPER_RE = /\b(helperPath|fixturePath)\(\s*["']([^"']+)["']/g;

const reasonCache = new Map<string, string | null>();

/** First network reason found in `file` or anything it reaches under tests/, else null. */
function networkReason(file: string, seen = new Set<string>()): string | null {
  if (reasonCache.has(file)) return reasonCache.get(file)!;
  if (seen.has(file)) return null;
  seen.add(file);
  const text = readFileSync(file, "utf8");
  let reason: string | null = null;
  for (const [pattern, label] of NETWORK_PATTERNS) {
    if (pattern.test(text)) {
      reason = label;
      break;
    }
  }
  if (!reason) {
    const targets: string[] = [];
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolveImport(file, m[1]!);
      if (target) targets.push(target);
    }
    for (const m of text.matchAll(PATH_HELPER_RE)) {
      const target = join(TESTS, m[1] === "helperPath" ? "helpers" : "fixtures", m[2]!);
      if (existsSync(target) && statSync(target).isFile()) targets.push(target);
    }
    for (const target of targets) {
      if (!posix(target).startsWith(posix(TESTS) + "/")) continue;
      const inner = networkReason(target, seen);
      if (inner) {
        reason = `${inner} (via ${rel(target)})`;
        break;
      }
    }
  }
  reasonCache.set(file, reason);
  return reason;
}

function loadList(path: string, label: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(path)) return map;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [file, ...note] = line.split("#");
    map.set(file!.trim(), `${label}${note.length ? `: ${note.join("#").trim()}` : ""}`);
  }
  return map;
}

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const showExcluded = args.includes("--excluded");
const timings = args.includes("--timings");
const includeSlow = timings || args.includes("--all");
const filters = args.filter(a => !a.startsWith("--")).map(a => posix(a).replace(/^\.\//, "").replace(/\/$/, ""));

const excludeList = loadList(join(ROOT, "fork", "test-exclude.txt"), "exclude list");
const slowList = includeSlow ? new Map<string, string>() : loadList(SLOW_LIST, "slow");
const selected: string[] = [];
const excluded: [string, string][] = [];
for (const file of walk(TESTS).sort()) {
  const name = rel(file);
  if (filters.length && !filters.some(f => name === f || name.startsWith(f + "/"))) continue;
  const reason = excludeList.get(name) ?? networkReason(file) ?? slowList.get(name);
  if (reason) excluded.push([name, reason]);
  else selected.push(name);
}

if (showExcluded) {
  for (const [name, reason] of excluded) console.log(`${name}\t${reason}`);
  console.log(`\n${excluded.length} skipped, ${selected.length} selected`);
  process.exit(0);
}
if (listOnly) {
  for (const name of selected) console.log(name);
  console.log(`\n${selected.length} selected, ${excluded.length} skipped`);
  process.exit(0);
}
if (selected.length === 0) {
  console.error("[fork-test] no offline test files matched");
  process.exit(1);
}

const slowSkipped = excluded.filter(([, r]) => r.startsWith("slow")).length;
console.log(`[fork-test] ${selected.length} files (${excluded.length - slowSkipped} network/excluded skipped, ${slowSkipped} slow skipped${includeSlow ? "" : "; --all runs them"})`);
const junitDir = join(ROOT, ".tmp", "fork-test-junit");
if (timings) {
  rmSync(junitDir, { recursive: true, force: true });
  mkdirSync(junitDir, { recursive: true });
}
const totals = { pass: 0, fail: 0, skip: 0 };
let failedBatches = 0;
const started = Date.now();
for (let i = 0; i < selected.length; i += BATCH_SIZE) {
  const batch = selected.slice(i, i + BATCH_SIZE);
  const reporter = timings ? ["--reporter=junit", `--reporter-outfile=${join(junitDir, `batch-${i}.xml`)}`] : [];
  const proc = Bun.spawn([process.execPath, ...RUNNER_ARGS, ...reporter, ...batch.map(f => `./${f}`)], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  const text = out + err;
  for (const key of ["pass", "fail", "skip"] as const) {
    const m = text.match(new RegExp(`^\\s*(\\d+) ${key}$`, "m"));
    if (m) totals[key] += Number(m[1]);
  }
  const failures = text.split(/\r?\n/).filter(l => l.startsWith("(fail)") || l.startsWith("# Unhandled error") || l.includes("OCX_FORK_NETWORK_BLOCKED"));
  if (code !== 0) {
    failedBatches++;
    process.stdout.write(text);
  }
  const done = Math.min(i + BATCH_SIZE, selected.length);
  console.log(`[fork-test] ${done}/${selected.length} files, ${((Date.now() - started) / 1000).toFixed(0)}s, batch exit ${code}${failures.length ? `, ${failures.length} failure line(s)` : ""}`);
}

if (timings) {
  const seconds = new Map<string, number>();
  for (const name of readdirSync(junitDir)) {
    const xml = readFileSync(join(junitDir, name), "utf8");
    for (const m of xml.matchAll(/<testsuite name="([^"]+)" file="([^"]+)"[^>]*\stime="([\d.]+)"/g)) {
      if (m[1] === m[2]) seconds.set(posix(m[2]!), Number(m[3]));
    }
  }
  const slow = [...seconds].filter(([, t]) => t > SLOW_SECONDS).sort((a, b) => b[1] - a[1]);
  const header = [
    `# Generated by \`bun fork/test.ts --timings\`: files over ${SLOW_SECONDS}s on their own, skipped unless --all.`,
    "# Regenerate after an upstream merge rather than editing by hand.",
    "",
  ];
  writeFileSync(SLOW_LIST, header.concat(slow.map(([f, t]) => `${f}  # ${t.toFixed(1)}s`)).join("\n") + "\n");
  const slowTotal = slow.reduce((sum, [, t]) => sum + t, 0);
  console.log(`[fork-test] timed ${seconds.size} files; ${slow.length} slow files (${slowTotal.toFixed(0)}s of test time) written to fork/test-slow.txt`);
}

console.log(`[fork-test] ${totals.pass} pass, ${totals.fail} fail, ${totals.skip} skip in ${((Date.now() - started) / 1000).toFixed(0)}s`);
process.exit(failedBatches > 0 ? 1 : 0);
