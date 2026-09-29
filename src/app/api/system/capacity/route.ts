// LeadOS — Capacity API (Final Hardening #2): حالة السعة الحية للوحة التحكم
// محمية بالجلسة — بترجع نفس أرقام بوابة الـActions (نفس التعريفات)
import { json, jsonError, requireAuth, isResponse } from "@/lib/api-helpers"
import { capacityState, revivalDecision, CHAINS, type ChainEvent } from "@/lib/supervisor"
import { farmInventorySummary } from "@/lib/farm-inventory"

export const maxDuration = 30

export async function GET() {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  try {
    const state = await capacityState()
    const chains = (Object.keys(CHAINS) as ChainEvent[]).map(event => {
      const c = state.perChain[event]
      const d = revivalDecision(state, event)
      return {
        event,
        name: c.name,
        priority: c.priority,
        need: c.need,
        critical: c.critical,
        activeRuns: c.active,
        activeJobs: c.active * c.need,
        lastRunAt: c.lastRunAt,
        gateDecision: d.allow ? "ALLOW" : "DEFER",
        gateReason: d.reason,
      }
    })
    return json({
      ok: true,
      limit: state.limit,
      runningJobs: state.activeJobs,
      queuedJobs: 0, // الـqueued محسوبة جوه activeJobs (status=queued من GitHub) — التفصيل عند الحاجة
      availableSlots: state.available,
      safetyMargin: state.safetyMargin,
      activeRuns: state.activeRuns,
      chains,
      farm: farmInventorySummary(),
      stop: state.stop,
      checkedAt: new Date().toISOString(),
      source: "GitHub Actions API — حساب حي لحظي",
    })
  } catch (e) {
    return jsonError(`فشل حساب السعة: ${e instanceof Error ? e.message.slice(0, 100) : "خطأ"}`, 502)
  }
}
