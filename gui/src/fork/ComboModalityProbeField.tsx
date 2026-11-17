import { useEffect, useState } from "react";
import type { ModelOption } from "../components/combo-workspace-types";
import { probeCandidates } from "./modality-probe-candidates";

/**
 * Fork (FORK.md, "Modality probe"): test image input on combo targets whose catalog row does not
 * declare it. A pass declares image for that model on the server; the page then reloads its model
 * rows so the image switch above can turn on. English-only copy on purpose, like the other fork
 * fields, so the fork does not touch upstream's locale catalogs.
 */
interface ProbeRecord { ok: boolean; at: string; answer?: string; error?: string; declared?: boolean }
type ProbeStore = Record<string, { image?: ProbeRecord }>;

const PROBE_PATH = "/api/fork/modality-probes";

function describeRecord(record: ProbeRecord): string {
  const when = new Date(record.at).toLocaleString();
  if (record.ok) return `Passed ${when}${record.declared ? " — image input declared" : ""}.`;
  return `Failed ${when}: ${record.error ?? "no reply"}${record.answer ? ` (reply: "${record.answer}")` : ""}`;
}

export function ComboModalityProbeField({
  apiBase = "",
  targets,
  models,
  disabled,
  onDeclared,
}: {
  apiBase?: string;
  targets: readonly { provider: string; model: string }[];
  models: readonly ModelOption[];
  disabled?: boolean;
  /** Called after a pass declared image input, so the page reloads its model rows. */
  onDeclared?: () => void;
}) {
  const candidates = probeCandidates(targets, models);
  const [store, setStore] = useState<ProbeStore>({});
  const [running, setRunning] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (candidates.length === 0) return;
    const controller = new AbortController();
    fetch(apiBase + PROBE_PATH, { signal: controller.signal })
      .then(response => response.ok ? response.json() as Promise<{ probes?: ProbeStore }> : null)
      .then(payload => { if (payload?.probes) setStore(payload.probes); })
      .catch(() => { /* Past results are optional. */ });
    return () => controller.abort();
  }, [apiBase, candidates.length]);

  if (candidates.length === 0) return null;

  const run = async (provider: string, model: string) => {
    const key = `${provider}/${model}`;
    setRunning(key);
    setErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
    try {
      const response = await fetch(apiBase + PROBE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, model, modality: "image" }),
      });
      const payload = await response.json().catch(() => null) as (ProbeRecord & { error?: string }) | null;
      if (!response.ok || !payload || typeof payload.ok !== "boolean") {
        setErrors(previous => ({ ...previous, [key]: payload?.error ?? `Probe request failed (HTTP ${response.status}).` }));
        return;
      }
      setStore(previous => ({ ...previous, [key]: { ...previous[key], image: payload } }));
      if (payload.ok && payload.declared) onDeclared?.();
    } catch {
      setErrors(previous => ({ ...previous, [key]: "Probe request failed." }));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="cwi-field" data-testid="combo-modality-probe">
      <span className="field-label">Image input test</span>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
        These targets don't declare image input. The test sends the model a picture of a random number; if it reads the
        number back, image input is declared for that model.
      </p>
      <div style={{ display: "grid", gap: 6 }}>
        {candidates.map(({ provider, model, declared }) => {
          const key = `${provider}/${model}`;
          const record = store[key]?.image;
          return (
            <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code style={{ fontSize: 12 }}>{key}</code>
              <span className="muted" style={{ fontSize: 12 }}>
                {declared && declared.length > 0 ? `declares ${declared.join(", ")}` : "modalities not declared"}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={disabled || running !== null}
                onClick={() => { void run(provider, model); }}
              >
                {running === key ? "Testing…" : "Test image input"}
              </button>
              {errors[key] ? <span className="cwi-capability-hint--warn" style={{ fontSize: 12 }}>{errors[key]}</span>
                : record ? <span className="muted" style={{ fontSize: 12 }}>{describeRecord(record)}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
