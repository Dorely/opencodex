/**
 * Fork (see FORK.md, "Modality probe"): test whether a routed model really accepts image input, and
 * declare it when it does.
 *
 * A provider's catalog can leave a model's input modalities undeclared or wrong. The probe sends
 * that exact model a generated image of a random number through the proxy's own
 * `/v1/chat/completions` (so the real adapter compiles the wire) and asks it to read the number.
 * Only a correct read-back passes, and only a pass writes `modelCapabilities[model].inputModalities`
 * (the same field the Model settings dialog edits) with image added. Every result, pass or fail, is
 * recorded in `<config dir>/fork/modality-probes.json`.
 *
 * The probe names a provider model directly, so it carries the process's internal-call capability
 * in {@link MODALITY_PROBE_HEADER}; the chat surface then skips the hidden-model refusal, since the
 * operator chose this call. A model declared text-only is refused: the Vision Sidecar would describe
 * the image for it and the probe would pass without the model ever seeing it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config/paths";
import { hasOwnProvider, isValidProviderName, saveConfigPreservingClaudeCode } from "../../config";
import { ConfigWritePublishedError } from "../../config/persist-unlocked";
import { clearModelCache } from "../../codex/model-cache";
import { postLocalChatCompletion } from "../../lib/local-chat-completion";
import { internalCallCapability } from "../../lib/local-internal-call-capability";
import { redactSecretString } from "../../lib/redact";
import { isValidModelDiscoveryModelId } from "../../providers/model-discovery-limits";
import { modelRecordValue } from "../../reasoning-effort";
import { MODALITY_PROBE_HEADER } from "../../routing/hidden-models";
import { isVisionSidecarConsumer } from "../../vision/eligibility";
import { answerMatchesCode, randomProbeCode, renderDigitsPng } from "../../vision/fork-probe-image";
import type { OcxConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { commitProviderPatch } from "./provider-patch-transaction";

export const MODALITY_PROBE_PATH = "/api/fork/modality-probes";
const PROBE_TIMEOUT_MS = 90_000;
const PROBE_PROMPT = "What number is shown in this image? Reply with the digits only.";

export interface ModalityProbeRecord {
  ok: boolean;
  at: string;
  /** The model's reply, truncated and redacted. */
  answer?: string;
  error?: string;
  /** True when this pass added image to the model's declared modalities. */
  declared?: boolean;
}
export type ModalityProbeStore = Record<string, { image?: ModalityProbeRecord }>;

export function modalityProbeStorePath(configDir = getConfigDir()): string {
  return join(configDir, "fork", "modality-probes.json");
}

export function readModalityProbes(path = modalityProbeStorePath()): ModalityProbeStore {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ModalityProbeStore : {};
  } catch { return {}; }
}

function recordProbe(key: string, record: ModalityProbeRecord, path = modalityProbeStorePath()): void {
  const store = readModalityProbes(path);
  store[key] = { ...store[key], image: record };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** The modalities the model resolves to now: capability axis, then per-model map, then provider-wide. */
export function currentDeclaredModalities(config: OcxConfig, provider: string, modelId: string): string[] | undefined {
  const row = config.providers[provider];
  if (!row) return undefined;
  const capability = Object.hasOwn(row.modelCapabilities ?? {}, modelId) ? row.modelCapabilities?.[modelId]?.inputModalities : undefined;
  return capability ?? modelRecordValue(row.modelInputModalities, modelId) ?? row.inputModalities;
}

/** Image added to what the model resolves to, keeping text; text alone when nothing is declared. */
export function withImageModality(current: readonly string[] | undefined): string[] {
  const base = current && current.length > 0 ? current : ["text"];
  return [...new Set([...base.includes("text") ? [] : ["text"], ...base, "image"])];
}

export type ProbeSender = (body: Record<string, unknown>, headers: Record<string, string>) => Promise<{ text: string; error?: string }>;

export interface RunModalityProbeDeps {
  send?: ProbeSender;
  code?: string;
  now?: () => Date;
}

/** Send the image to `provider/modelId` and judge the reply. Never writes config. */
export async function runImageProbe(
  config: OcxConfig,
  provider: string,
  modelId: string,
  deps: RunModalityProbeDeps = {},
  signal?: AbortSignal,
): Promise<ModalityProbeRecord> {
  const code = deps.code ?? randomProbeCode();
  const image = `data:image/png;base64,${Buffer.from(renderDigitsPng(code)).toString("base64")}`;
  const send: ProbeSender = deps.send ?? ((body, headers) => postLocalChatCompletion({
    config, body, headers, label: "modality probe", logTag: "fork-probe",
    timeoutMs: PROBE_TIMEOUT_MS, maxResponseBytes: 1024 * 1024, boundWhileStreaming: true, abortSignal: signal,
  }));
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const outcome = await send({
    model: `${provider}/${modelId}`,
    messages: [{ role: "user", content: [
      { type: "text", text: PROBE_PROMPT },
      { type: "image_url", image_url: { url: image } },
    ] }],
  }, { [MODALITY_PROBE_HEADER]: internalCallCapability() });
  if (outcome.error) return { ok: false, at, error: redactSecretString(outcome.error).slice(0, 300) };
  const answer = redactSecretString(outcome.text.trim()).slice(0, 200);
  if (!answerMatchesCode(outcome.text, code)) return { ok: false, at, answer, error: "The reply did not contain the number shown in the image." };
  return { ok: true, at, answer };
}

function invalid(message: string, status = 400): Response { return jsonResponse({ error: message }, status); }

export async function handleForkModalityProbeRoutes(
  ctx: Pick<ManagementContext, "req" | "url" | "config" | "deps" | "convergeCodexCatalog">,
  probeDeps: RunModalityProbeDeps & { storePath?: string } = {},
): Promise<Response | null> {
  const { req, url, config, deps } = ctx;
  if (url.pathname !== MODALITY_PROBE_PATH) return null;
  const storePath = probeDeps.storePath ?? modalityProbeStorePath();
  if (req.method === "GET") return jsonResponse({ probes: readModalityProbes(storePath) });
  if (req.method !== "POST") return null;

  let body: unknown;
  try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return invalid("invalid JSON body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid modality probe request");
  const { provider: rawProvider, model: rawModel, modality } = body as Record<string, unknown>;
  if (Object.keys(body).some(key => !["provider", "model", "modality"].includes(key))) return invalid("invalid modality probe request");
  if (modality !== undefined && modality !== "image") return invalid("only the image modality can be probed");
  const provider = typeof rawProvider === "string" ? rawProvider.trim() : "";
  const modelId = typeof rawModel === "string" ? rawModel : "";
  if (!provider || !modelId || !isValidModelDiscoveryModelId(modelId) || ["__proto__", "constructor", "prototype"].includes(modelId)) {
    return invalid("provider and model are required");
  }
  if (provider === "openai" || provider === "combo") return invalid("only routed provider models can be probed");
  if (!isValidProviderName(provider) || !hasOwnProvider(config.providers, provider)) return invalid("unknown provider", 404);
  if (isVisionSidecarConsumer(config, provider, modelId)) {
    return invalid("This model is declared text-only, so the Vision Sidecar would read the image for it. Clear its input modalities in Model settings, then run the probe.", 409);
  }

  const key = `${provider}/${modelId}`;
  const record = await runImageProbe(config, provider, modelId, probeDeps, req.signal);
  let catalogRefresh: unknown;
  if (record.ok) {
    const current = currentDeclaredModalities(config, provider, modelId);
    if (!current?.includes("image")) {
      const next = withImageModality(current);
      const providerConfig = { ...config.providers[provider]! };
      const capabilities = Object.assign(Object.create(null), providerConfig.modelCapabilities ?? {}) as NonNullable<typeof providerConfig.modelCapabilities>;
      capabilities[modelId] = { ...(capabilities[modelId] ?? {}), inputModalities: next as NonNullable<typeof capabilities[string]["inputModalities"]> };
      providerConfig.modelCapabilities = capabilities;
      try {
        commitProviderPatch(config, () => { config.providers[provider] = providerConfig; }, deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode);
        record.declared = true;
      } catch (error) {
        if (!(error instanceof ConfigWritePublishedError)) {
          record.error = "The probe passed, but the image modality could not be saved.";
        } else record.declared = true;
      }
      if (record.declared) {
        clearModelCache(provider);
        try { catalogRefresh = await ctx.convergeCodexCatalog(); } catch { catalogRefresh = { status: "failed" }; }
      }
    }
  }
  try { recordProbe(key, record, storePath); } catch { /* The result is still returned; the record is best-effort. */ }
  return jsonResponse({ provider, model: modelId, modality: "image", ...record, ...(catalogRefresh ? { catalogRefresh } : {}) });
}
