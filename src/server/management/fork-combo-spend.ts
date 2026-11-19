/**
 * Fork (see FORK.md, "Combo quota limits"): current estimated spend per provider, shown beside the
 * combo editor's spend limits. Read-only; refreshes the spend tracker from the usage log first.
 */
import { allProviderSpend, monthStartMs, refreshComboSpend, weekStartMs } from "../../combos/spend-tracker";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export const COMBO_SPEND_PATH = "/api/fork/combo-spend";

export async function handleForkComboSpendRoutes(
  ctx: Pick<ManagementContext, "req" | "url">,
  refresh: () => Promise<void> = refreshComboSpend,
): Promise<Response | null> {
  if (ctx.url.pathname !== COMBO_SPEND_PATH || ctx.req.method !== "GET") return null;
  await refresh();
  const now = Date.now();
  return jsonResponse({
    weekStart: new Date(weekStartMs(now)).toISOString(),
    monthStart: new Date(monthStartMs(now)).toISOString(),
    providers: allProviderSpend(now),
  });
}
