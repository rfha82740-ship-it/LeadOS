// LeadOS — Supervisor المركزي (Final Hardening #2): مشرف السعة والإحياء من جهة التطبيق
// بيشتغل مع كل نبضة /api/cron/tick — مستقل عن صحة الـworkflows (التطبيق على Vercel دايمًا حي).
// الوظايف: (1) قراءة حالة السعة الحية (2) إحياء أي سلسلة ميتة/مؤجلة بشرط السعة والـcooldown (3) احترام STOP.
// الميزانية مرآة لـ.github/concurrency-budget.json (مصدر الـgate في Actions) — التدقيق بيتأكد إنهم متطابقين.
export const GH_JOB_LIMIT = 20
export const SAFETY_MARGIN = 1

export const CHAINS = {
  beat_tick: { workflow: "cron-tick.yml", name: "Cron Tick", priority: 0, need: 1, critical: true, deferred: false, cooldownMin: 5 },
  beat_worker: { workflow: "worker.yml", name: "Worker", priority: 1, need: 1, critical: true, deferred: false, cooldownMin: 5 },
  beat_adslib: { workflow: "ads-library.yml", name: "Ads Library", priority: 2, need: 1, critical: false, deferred: false, cooldownMin: 5 },
  beat_fbgroups: { workflow: "fb-groups.yml", name: "FB Groups", priority: 2, need: 1, critical: false, deferred: false, cooldownMin: 5 },
  beat_radar: { workflow: "radar.yml", name: "Radar", priority: 2, need: 1, critical: false, deferred: false, cooldownMin: 5 },
  beat_farm: { workflow: "browser-farm.yml", name: "Browser Farm", priority: 3, need: 15, critical: false, deferred: true, cooldownMin: 10 },
} as const

export type ChainEvent = keyof typeof CHAINS
export interface CapacityState {
  limit: number
  safetyMargin: number
  activeJobs: number
  activeRuns: number
  available: number
  stop: boolean
  perChain: Record<string, { name: string; priority: number; need: number; critical: boolean; active: number; lastRunAt: string | null }>
}

function ghConf() {
  return { token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPO, ready: Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) }
}

async function gh<T>(path: string, init?: RequestInit): Promise<T> {
  const { token, repo } = ghConf()
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`GitHub ${res.status} على ${path}`)
  return res.json() as Promise<T>
}

export async function stopFileExists(): Promise<boolean> {
  const { token, repo } = ghConf()
  if (!token || !repo) return false
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/.github/STOP`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    })
    return res.status === 200
  } catch {
    return false
  }
}

/** حالة السعة الحية — نفس منطق scripts/capacity-gate.mjs */
export async function capacityState(): Promise<CapacityState> {
  const perChain: CapacityState["perChain"] = {}
  for (const [event, c] of Object.entries(CHAINS)) {
    perChain[event] = { name: c.name, priority: c.priority, need: c.need, critical: c.critical, active: 0, lastRunAt: null }
  }
  const runs: { status: string; created_at: string; path: string }[] = []
  for (let page = 1; page <= 3; page++) {
    const d = await gh<{ workflow_runs: { status: string; created_at: string; path: string }[] }>(`/actions/runs?per_page=100&page=${page}`)
    runs.push(...d.workflow_runs)
    if (d.workflow_runs.length < 100) break
  }
  for (const r of runs) {
    const entry = Object.entries(CHAINS).find(([, c]) => r.path === `.github/workflows/${c.workflow}`)
    if (!entry) continue
    const [, chain] = entry
    const slot = perChain[entry[0]]
    if (!slot.lastRunAt || new Date(r.created_at) > new Date(slot.lastRunAt)) slot.lastRunAt = r.created_at
    if (["in_progress", "queued", "waiting"].includes(r.status)) slot.active++
  }
  const activeJobs = Object.entries(perChain).reduce((s, [event, c]) => s + c.active * CHAINS[event as ChainEvent].need, 0)
  const stop = await stopFileExists()
  return {
    limit: GH_JOB_LIMIT,
    safetyMargin: SAFETY_MARGIN,
    activeJobs,
    activeRuns: Object.values(perChain).reduce((s, c) => s + c.active, 0),
    available: Math.max(0, GH_JOB_LIMIT - activeJobs),
    stop,
    perChain,
  }
}

/** قرار الإحياء لسلسلة: بدون تشغيلة نشطة + بعد الـcooldown + سعة كافية (منطق مطابق للبوابة) */
export function revivalDecision(state: CapacityState, event: ChainEvent): { allow: boolean; reason: string } {
  const c = state.perChain[event]
  const meta = CHAINS[event]
  if (state.stop) return { allow: false, reason: "STOP فعال — ممنوع أي dispatch" }
  if (c.active > 0) return { allow: false, reason: `${c.name} نشطة بالفعل` }
  if (c.lastRunAt) {
    const ageMin = (Date.now() - new Date(c.lastRunAt).getTime()) / 60_000
    if (ageMin < meta.cooldownMin) return { allow: false, reason: `${c.name} آخر تشغيل قبل ${ageMin.toFixed(1)} د — cooldown ${meta.cooldownMin} د` }
  }
  const deadOthers = Object.entries(state.perChain).filter(([e, x]) => e !== event && x.active === 0).length
  const need = meta.need + (meta.deferred && deadOthers > 0 ? state.safetyMargin : 0)
  if (state.available < need) return { allow: false, reason: `سعة غير كافية: ${state.available} < ${need}` }
  return { allow: true, reason: `سعة ${state.available} ≥ ${need} — إحياء ${c.name}` }
}

/** المشرف: يحيي السلاسل الميتة/المؤجلة (تُستدعى من نبضة التطبيق — فشلها لا يؤثر على النبضة أبدًا) */
export async function superviseChains(): Promise<{ ok: boolean; revived: string[]; skipped: string[]; error?: string; capacity?: CapacityState }> {
  const { ready } = ghConf()
  if (!ready) return { ok: false, revived: [], skipped: [], error: "GITHUB_TOKEN/GITHUB_REPO غير متوفرين — المشرف معطّل (زر الإيقاف يدوي من GitHub)" }
  try {
    const state = await capacityState()
    const revived: string[] = []
    const skipped: string[] = []
    if (state.stop) return { ok: true, revived, skipped: ["STOP فعال — كل السلاسل موقوفة"], capacity: state }
    // ترتيب بالأولوية: الحرِجة أولًا
    const ordered = (Object.keys(CHAINS) as ChainEvent[]).sort((a, b) => CHAINS[a].priority - CHAINS[b].priority)
    for (const event of ordered) {
      const d = revivalDecision(state, event)
      if (!d.allow) {
        skipped.push(`${CHAINS[event].name}: ${d.reason}`)
        continue
      }
      try {
        await gh("/dispatches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event_type: event }),
        })
        revived.push(`${CHAINS[event].name} (${d.reason})`)
        state.perChain[event].active = 1 // منع dispatch مزدوج في نفس النبضة
      } catch (e) {
        skipped.push(`${CHAINS[event].name}: فشل dispatch — ${e instanceof Error ? e.message.slice(0, 80) : "خطأ"}`)
      }
    }
    return { ok: true, revived, skipped, capacity: state }
  } catch (e) {
    return { ok: false, revived: [], skipped: [], error: e instanceof Error ? e.message.slice(0, 140) : "خطأ" }
  }
}
