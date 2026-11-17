/**
 * Fork-only test preload (see FORK.md): tests perform no real network I/O at all.
 *
 * Loaded for every `bun test` that reads bunfig.toml. There is no switch to turn it off; live and
 * server-backed checks happen by hand, outside the suite.
 *
 * - Live opt-in switches, provider credentials, and outbound proxy variables are removed from the
 *   environment before any test module loads, so env-gated live suites always skip and nothing can
 *   be forwarded through a developer's real proxy.
 * - Real `fetch`, `WebSocket`, `Bun.serve`, `Bun.listen`, `Bun.connect`, `Bun.udpSocket`, and the
 *   `node:net` / `node:http` / `node:https` / `node:tls` server and client entry points throw
 *   OCX_FORK_NETWORK_BLOCKED, loopback included. A test that installs its own fetch stub is
 *   unaffected; `data:`, `blob:`, and `file:` URLs still work.
 *
 * `fork/test.ts` skips test files that need any of this, so a block here means a network test
 * slipped past its scan: add the file to `fork/test-exclude.txt`.
 */
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const LIVE_OPT_IN_ENV = new Set([
  "NOUS_LIVE_TEST",
  "OCX_ALLOW_LIVE_OPENAI_SMOKE",
  "CODEBUDDY_LIVE_TEST",
  "CODEBUDDY_LIVE_CLI_PATH",
  "CODEBUDDY_LIVE_API_KEY",
  "OPENCODEX_CURSOR_TEST_TOKEN",
  "OPENCODEX_CURSOR_TEST_BASE_URL",
  "STEERING_DIRECT_TOKEN",
  "STEERING_PROXY_TOKEN",
  "STEERING_DIRECT_ACCOUNT_ID",
  "OCX_TEST_OPENCODE_BIN",
  "OCX_TEST_KILO_BIN",
  "OCX_TEST_LIVE_SCRATCH",
  "OCX_LINK_WS_RSS_ACCEPTANCE",
  "OCX_LINK_WS_RSS_CHILD_ACCEPTANCE",
  "OCX_OPENSSH_ROUTE_FIXTURE",
]);

const CREDENTIAL_ENV = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "HF_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

for (const name of Object.keys(process.env)) {
  if (
    LIVE_OPT_IN_ENV.has(name)
    || CREDENTIAL_ENV.has(name)
    || /_API_KEY$/i.test(name)
    || /^(https?|all|ws|wss)_proxy$/i.test(name)
  ) {
    delete process.env[name];
  }
}

function blocked(what: string): TypeError {
  return new TypeError(`OCX_FORK_NETWORK_BLOCKED: tests may not use ${what} (see FORK.md)`);
}

function targetOf(input: unknown): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return String(input);
}

function isNetworkUrl(raw: string): boolean {
  try {
    return ["http:", "https:", "ws:", "wss:"].includes(new URL(raw).protocol);
  } catch {
    return false;
  }
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = targetOf(input);
    if (isNetworkUrl(target)) return Promise.reject(blocked(`fetch(${target})`));
    return nativeFetch(input, init);
  },
  {
    preconnect: (url: string | URL) => {
      throw blocked(`fetch.preconnect(${targetOf(url)})`);
    },
  },
) as typeof fetch;

if (globalThis.WebSocket) {
  const Native = globalThis.WebSocket;
  class BlockedWebSocket extends Native {
    constructor(url: string | URL) {
      throw blocked(`WebSocket(${targetOf(url)})`);
      super(url);
    }
  }
  globalThis.WebSocket = BlockedWebSocket as typeof WebSocket;
}

function stub(target: Record<string, unknown>, label: string, names: string[]): void {
  for (const name of names) {
    try {
      target[name] = () => {
        throw blocked(`${label}.${name}`);
      };
    } catch { /* frozen builtin: covered by fork/test.ts exclusion */ }
  }
}

// Bun's network entry points are non-configurable but writable, so plain assignment replaces them.
stub(Bun as unknown as Record<string, unknown>, "Bun", ["serve", "listen", "connect", "udpSocket"]);
stub(net as unknown as Record<string, unknown>, "node:net", ["createServer", "connect", "createConnection"]);
stub(http as unknown as Record<string, unknown>, "node:http", ["createServer", "request", "get"]);
stub(https as unknown as Record<string, unknown>, "node:https", ["createServer", "request", "get"]);
stub(tls as unknown as Record<string, unknown>, "node:tls", ["createServer", "connect"]);
