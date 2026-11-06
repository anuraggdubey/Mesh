import { planAmountTinybars } from "./agent-runner";
import { tinybarsToHbar } from "./credits";
import type { PlanView } from "./plans";

/** The plan as the UI sees it. Only a 0G plan carries a request id; a manual plan says plainly that 0G was not used. */
export function planResponse(plan: PlanView) {
  return {
    planId: plan.planId,
    source: plan.source,
    preset: plan.preset,
    price: plan.price,
    priceHbar: tinybarsToHbar(planAmountTinybars(plan)),
    reason: plan.reason,
    expiresAt: plan.expiresAt,
    og: plan.og,
  };
}
