/**
 * Hidden models refuse direct calls (fork feature, see FORK.md).
 *
 * Upstream's `disabledModels` hides a model from discovery (the Codex catalog, `/v1/models`, the
 * pickers) but still routes a request that names it. In this fork a hidden model is also refused
 * when a client names it, whether by its full `provider/model` id, an alias, or a bare id that
 * resolves to it. A hidden combo is refused the same way.
 *
 * What is checked is the selector the CLIENT chose, never a destination the operator configured on
 * its behalf: a combo's targets, a policy candidate, a blocked-model redirect target, a fallback
 * chain or a compaction route still reach a hidden model, because hiding is about what a client may
 * pick, and the operator chose those routes explicitly.
 *
 * Codex's own hard-coded helper and memory models (`SHADOW_SOURCE_MODEL_OPTIONS`) stay callable
 * when requested bare: Codex sends them for titles, commit messages and memory without the user
 * picking them, and refusing them would break those features for anyone who hid the model from
 * the picker.
 */
import { comboDisabledModelSelectors, resolveComboId } from "../combos/identifiers";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers-destination";
import { slugEquals } from "../providers/slug-codec";
import { SHADOW_SOURCE_MODEL_OPTIONS, shadowSourceModels } from "../lib/shadow-call";
import type { OcxConfig } from "../types";

export const MODEL_HIDDEN_CODE = "model_hidden";

export class HiddenModelError extends Error {
  readonly code = MODEL_HIDDEN_CODE;
  constructor(readonly requestedModel: string) {
    super(`Model "${requestedModel}" is hidden. Unhide it in opencodex to call it.`);
    this.name = "HiddenModelError";
  }
}

/** The part of a resolved route this check reads. */
export interface HiddenModelRoute {
  readonly providerName: string;
  readonly modelId: string;
  readonly routeKind?: string;
  readonly routeReason?: string;
  readonly codexAccountNamespace?: string;
  readonly combo?: { readonly comboId: string };
}

function disabledSet(config: Pick<OcxConfig, "disabledModels">): ReadonlySet<string> | null {
  const list = config.disabledModels;
  return Array.isArray(list) && list.length > 0 ? new Set(list) : null;
}

/** Codex's own helper/memory ids, requested bare, are never refused (see module doc). */
function isCodexHelperModel(config: Pick<OcxConfig, "shadowCallIntercept">, requested: string): boolean {
  if (requested.includes("/")) return false;
  if (SHADOW_SOURCE_MODEL_OPTIONS.some(option => option.id === requested)) return true;
  return shadowSourceModels(config.shadowCallIntercept?.sourceModels).some(prefix => requested === prefix);
}

/** True when `comboId` is hidden through any selector that can name it in `disabledModels`. */
export function comboIsHidden(config: Pick<OcxConfig, "disabledModels" | "combos">, comboId: string): boolean {
  const disabled = disabledSet(config);
  const combo = config.combos?.[comboId];
  if (!disabled || !combo) return false;
  return comboDisabledModelSelectors(comboId, combo).some(selector => disabled.has(selector));
}

/**
 * The client-requested combo `requestedModel` names, when that combo is hidden; else null.
 * Used where a combo request is dispatched before the router runs.
 */
export function hiddenRequestedComboId(
  config: Pick<OcxConfig, "disabledModels" | "combos">,
  requestedModel: string | undefined,
): string | null {
  if (typeof requestedModel !== "string" || !disabledSet(config)) return null;
  const comboId = resolveComboId(config, requestedModel);
  return comboId && comboIsHidden(config, comboId) ? comboId : null;
}

/** Whether a client naming `requestedModel`, resolved to `route`, asked for a hidden model. */
export function isHiddenModelRequest(config: OcxConfig, requestedModel: string, route: HiddenModelRoute): boolean {
  const disabled = disabledSet(config);
  if (!disabled || isCodexHelperModel(config, requestedModel)) return false;
  if (disabled.has(requestedModel)) return true;
  const requestedCombo = route.combo?.comboId ?? resolveComboId(config, requestedModel);
  if (requestedCombo) return comboIsHidden(config, requestedCombo);
  // Operator-chosen destinations: only the selector itself (checked above) can be hidden.
  if (route.routeKind === "policy" || route.routeReason === "blocked-model-redirect") return false;
  for (const stored of disabled) {
    if (slugEquals(stored, route.providerName, route.modelId)) return true;
  }
  if (route.codexAccountNamespace && disabled.has(`${route.codexAccountNamespace}/${route.modelId}`)) return true;
  // A bare native id hides that model family (types/config.ts `disabledModels`).
  return route.providerName === OPENAI_CODEX_PROVIDER_ID && !route.codexAccountNamespace && disabled.has(route.modelId);
}

/** Throw {@link HiddenModelError} when a client-requested selector resolves to a hidden model. */
export function assertModelNotHidden(config: OcxConfig, requestedModel: string, route: HiddenModelRoute): void {
  if (isHiddenModelRequest(config, requestedModel, route)) throw new HiddenModelError(requestedModel);
}
