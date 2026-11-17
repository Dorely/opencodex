import { clampedNumberInput } from "../components/combo-workspace-utils";
import {
  comboTargetProviders,
  setQuotaLimitWindow,
  type ComboQuotaLimitDraft,
  type ComboQuotaWindow,
} from "./combo-quota-limits";

/**
 * Fork: per-provider quota cutoffs for one combo. English-only copy on purpose, so the fork does
 * not touch upstream's eleven locale catalogs.
 */
export function ComboQuotaLimitsField({
  targets,
  limits,
  disabled,
  onChange,
}: {
  targets: readonly { provider: string }[];
  limits: readonly ComboQuotaLimitDraft[] | undefined;
  disabled?: boolean;
  onChange: (limits: ComboQuotaLimitDraft[]) => void;
}) {
  const providers = comboTargetProviders(targets);
  const windows: { key: ComboQuotaWindow; label: string }[] = [
    { key: "fiveHourPercent", label: "5-hour %" },
    { key: "weeklyPercent", label: "Weekly %" },
  ];
  return (
    <div className="cwi-field" data-testid="combo-quota-limits">
      <span className="field-label">Quota cutoffs</span>
      {providers.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Add a target to set a cutoff for its provider.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(8rem, auto) repeat(2, minmax(6rem, 8rem))", gap: "6px 12px", alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>Provider</span>
          {windows.map(window => <span key={window.key} className="muted" style={{ fontSize: 12 }}>{window.label}</span>)}
          {providers.map(provider => {
            const limit = (limits ?? []).find(candidate => candidate.provider === provider);
            return [
              <span key={`${provider}:name`} className="mono" style={{ overflowWrap: "anywhere" }}>{provider}</span>,
              ...windows.map(window => (
                <input
                  key={`${provider}:${window.key}`}
                  id={`cwi-quota-${provider}-${window.key}`}
                  aria-label={`${provider} ${window.label} cutoff`}
                  className="input mono"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  placeholder="none"
                  value={limit?.[window.key] ?? ""}
                  disabled={disabled}
                  onChange={(event) => onChange(setQuotaLimitWindow(
                    limits,
                    provider,
                    window.key,
                    clampedNumberInput(event.target.value, 0, 100),
                  ))}
                />
              )),
            ];
          })}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
        Skip a provider&apos;s targets in this combo while its 5-hour or weekly usage is above the percent.
        Blank means no cutoff. Unknown or stale usage never blocks.
      </p>
    </div>
  );
}
