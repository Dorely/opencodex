import type { ModelOption } from "../components/combo-workspace-types";

// Fork (FORK.md, "Modality probe").
/** Targets worth probing: routed rows that do not declare image input. Deduplicated, in order. */
export function probeCandidates(
  targets: readonly { provider: string; model: string }[],
  models: readonly ModelOption[],
): Array<{ provider: string; model: string; declared: string[] | undefined }> {
  const seen = new Set<string>();
  const out: Array<{ provider: string; model: string; declared: string[] | undefined }> = [];
  for (const target of targets) {
    const provider = target.provider.trim();
    const model = target.model.trim();
    if (!provider || !model || provider === "openai" || provider === "combo") continue;
    const key = `${provider}/${model}`;
    if (seen.has(key)) continue;
    const row = models.find(candidate => candidate.provider === provider && candidate.id === model);
    if (!row) continue;
    const declared = row.inputModalitiesDeclared ?? row.inputModalities;
    if (declared?.includes("image") && row.visionSidecarConsumer !== true) continue;
    seen.add(key);
    out.push({ provider, model, declared });
  }
  return out;
}
