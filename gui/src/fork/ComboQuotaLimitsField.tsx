import { useEffect, useState } from "react";
import { clampedNumberInput } from "../components/combo-workspace-utils";
import {
  comboTargetProviders,
  formatUsd,
  isSpendWindow,
  MAX_SPEND_LIMIT_USD,
  parseComboSpend,
  setQuotaLimitWindow,
  type ComboQuotaLimitDraft,
  type ComboQuotaWindow,
  type ProviderSpendView,
} from "./combo-quota-limits";

/**
 * Fork: per-provider quota and spend cutoffs for one combo. English-only copy on purpose, so the
 * fork does not touch upstream's eleven locale catalogs.
 */
export function ComboQuotaLimitsField({
  apiBase = "",
  targets,
  limits,
  disabled,
  onChange,
}: {
  apiBase?: string;
  targets: readonly { provider: string }[];
  limits: readonly ComboQuotaLimitDraft[] | undefined;
  disabled?: boolean;
  onChange: (limits: ComboQuotaLimitDraft[]) => void;
}) {
  const providers = comboTargetProviders(targets);
  const [spend, setSpend] = useState<Record<string, ProviderSpendView> | null>(null);
  useEffect(() => {
    if (providers.length === 0) return;
    const controller = new AbortController();
    fetch(`${apiBase}/api/fork/combo-spend`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(payload => setSpend(parseComboSpend(payload)))
      .catch(() => { /* spend display is optional */ });
    return () => controller.abort();
  }, [apiBase, providers.length]);

  const windows: { key: ComboQuotaWindow; label: string }[] = [
    { key: "fiveHourPercent", label: "5-hour %" },
    { key: "weeklyPercent", label: "Weekly %" },
    { key: "weeklySpendUsd", label: "Weekly $" },
    { key: "monthlySpendUsd", label: "Monthly $" },
  ];
  return (
    <div className="cwi-field" data-testid="combo-quota-limits">
      <span className="field-label">Quota and spend cutoffs</span>
      {providers.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Add a target to set a cutoff for its provider.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(8rem, auto) repeat(4, minmax(5rem, 7rem))", gap: "6px 12px", alignItems: "center", overflowX: "auto" }}>
          <span className="muted" style={{ fontSize: 12 }}>Provider</span>
          {windows.map(window => <span key={window.key} className="muted" style={{ fontSize: 12 }}>{window.label}</span>)}
          {providers.map(provider => {
            const limit = (limits ?? []).find(candidate => candidate.provider === provider);
            const used = spend?.[provider];
            return [
              <span key={`${provider}:name`} className="mono" style={{ overflowWrap: "anywhere" }}>
                {provider}
                {used ? (
                  <span className="muted" style={{ display: "block", fontSize: 11 }} data-testid={`combo-spend-${provider}`}>
                    {formatUsd(used.weekUsd)} this week · {formatUsd(used.monthUsd)} this month
                    {used.unpricedRequests > 0 ? ` · ${used.unpricedRequests} unpriced` : ""}
                  </span>
                ) : null}
              </span>,
              ...windows.map(window => {
                const spendWindow = isSpendWindow(window.key);
                const max = spendWindow ? MAX_SPEND_LIMIT_USD : 100;
                return (
                  <input
                    key={`${provider}:${window.key}`}
                    id={`cwi-quota-${provider}-${window.key}`}
                    aria-label={`${provider} ${window.label} cutoff`}
                    className="input mono"
                    type="number"
                    min={0}
                    max={max}
                    step={spendWindow ? 0.01 : 1}
                    placeholder="none"
                    value={limit?.[window.key] ?? ""}
                    disabled={disabled}
                    onChange={(event) => onChange(setQuotaLimitWindow(
                      limits,
                      provider,
                      window.key,
                      clampedNumberInput(event.target.value, 0, max),
                    ))}
                  />
                );
              }),
            ];
          })}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
        Skip a provider&apos;s targets in this combo while its 5-hour or weekly usage is above the percent, or once
        its estimated spend this calendar week (from Monday) or month reaches the dollar amount. Spend is opencodex&apos;s
        cost estimate for every request on that provider, not the provider&apos;s bill. Blank means no cutoff; unknown
        usage never blocks.
      </p>
    </div>
  );
}
