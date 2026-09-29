// LeadOS — System Control API v2: حالة النظام الرسمية + Emergency Stop/Start كامل (Final Hardening #5/#6)
// STOP = ملف .github/STOP في الريبو — كل السلاسل الستة بتفحصه (بداية/أثناء اللوب/قبل dispatch)
// + بوابة السعة (capacity-gate) بترفض أي dispatch وهو موجود.
// الحالة الرسمية محفوظة في SystemState (جدول واحد) مع الأدلة: stoppedAt/By، reason، resumedAt/By.
// تدفق الإيقاف: STOPPING → كتابة الملف → تأكيد القراءة 200 → STOPPED (موثق).
// تدفق التشغيل: حذف الملف → تأكيد 404 → dispatch جيل واحد لكل سلسلة عبر بوابة السعة (بدون عاصفة) → RUNNING.
import { db } from "@/lib/db"
import { json, jsonError, requireAuth, isResponse, readBody } from "@/lib/api-helpers"
import { stopFileExists, capacityState, revivalDecision, CHAINS, type ChainEvent } from "@/lib/supervisor"

export const maxDuration = 60

const SINGLETON = "singleton"

function ghConf() {
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPO // صيغة: owner/name
  return { token, repo, ready: Boolean(token && repo) }
}

async function ghApi(path: string, init?: RequestInit): Promise<Response> {
  const { token, repo } = ghConf()
  return fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  })
}

async function getStopSha(): Promise<{ exists: boolean; sha?: string; status: number }> {
  const res = await ghApi(`/contents/.github/STOP`)
  if (res.status === 200) {
    const d = (await res.json()) as { sha?: string }
    return { exists: true, sha: d.sha, status: 200 }
  }
  return { exists: false, status: res.status }
}

async function getSystemState() {
  return (await db.systemState.findUnique({ where: { id: SINGLETON } })) ?? { id: SINGLETON, state: "RUNNING", reason: null, stoppedAt: null, stoppedBy: null, resumedAt: null, resumedBy: null, updatedAt: new Date() }
}

export async function GET() {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const wsId = auth.workspace.id
  const { ready } = ghConf()

  let stopFile = "unknown"
  if (ready) {
    try {
      stopFile = (await getStopSha()).exists ? "EXISTS" : "ABSENT"
    } catch {
      stopFile = "unreachable"
    }
  }

  const [lastTick, runningJobs, failedJobs, activeGraphs, sys] = await Promise.all([
    db.job.findFirst({ where: { type: "DISCOVERY", status: "SUCCESS" }, orderBy: { completedAt: "desc" }, select: { completedAt: true } }).catch(() => null),
    db.job.count({ where: { workspaceId: wsId, status: "RUNNING" } }).catch(() => 0),
    db.job.count({ where: { workspaceId: wsId, status: "FAILED", completedAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }).catch(() => 0),
    db.taskGraph.count({ where: { workspaceId: wsId, status: "ACTIVE" } }).catch(() => 0),
    getSystemState(),
  ])

  const ageMin = lastTick?.completedAt ? (Date.now() - lastTick.completedAt.getTime()) / 60_000 : null
  // الحقيقة الحية أولًا: الملف موجود = STOPPED؛ البديل = حالة السجل الرسمية
  const liveState =
    stopFile === "EXISTS" ? "STOPPED"
    : stopFile === "ABSENT"
      ? ageMin === null ? "UNKNOWN" : ageMin <= 15 ? "RUNNING" : ageMin <= 60 ? "DEGRADED" : "IDLE"
      : (sys.state ?? "UNKNOWN")

  // مزامنة السجل الرسمي مع الحقيقة الحية (بدون لمس أدلة الإيقاف اليدوية)
  if (ready && stopFile !== "unknown" && sys.state !== liveState && (liveState === "STOPPED" || liveState === "RUNNING" || liveState === "DEGRADED")) {
    await db.systemState.upsert({
      where: { id: SINGLETON },
      update: { state: liveState },
      create: { id: SINGLETON, state: liveState },
    }).catch(() => undefined)
  }

  return json({
    ok: true,
    systemState: liveState,
    recordedState: sys.state,
    stopFile,
    stopControlReady: ready,
    stopHint: ready ? null : "لتفعيل زر الإيقاف من اللوحة: أضف متغيري GITHUB_TOKEN (Contents: read+write) و GITHUB_REPO (owner/name) في Vercel. أو أنشئ الملف يدويًا من واجهة GitHub: Add file → .github/STOP",
    stopMeta: { stoppedAt: sys.stoppedAt, stoppedBy: sys.stoppedBy, reason: sys.reason, resumedAt: sys.resumedAt, resumedBy: sys.resumedBy },
    metrics: { lastSuccessfulTick: lastTick?.completedAt ?? null, runningJobs, failedJobs24h: failedJobs, activeGraphs },
    checkedAt: new Date().toISOString(),
  })
}

export async function POST(req: Request) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  // منع الإيقاف الخطير بدون تأكيد صريح (طلب #10) — التأكيد نصي حرفي
  const body = await readBody<{ confirm?: string; mode?: "stop" | "resume"; reason?: string }>(req)
  const mode = body?.mode === "resume" ? "resume" : "stop"
  if (mode === "stop" && body?.confirm !== "STOP") {
    return jsonError("التأكيد مطلوب: أرسل { confirm: \"STOP\", mode: \"stop\" } — الإيقاف يوقف كل السلاسل", 400)
  }
  const { ready } = ghConf()
  if (!ready) {
    return json({
      ok: false,
      performed: false,
      reason: "GITHUB_TOKEN / GITHUB_REPO غير متوفرين في بيئة Vercel — لا يمكن الكتابة على الريبو من هنا",
      manualSteps: [
        "من واجهة GitHub: Add file → Create new file → المسار .github/STOP (محتوى أي حاجة) → Commit",
        "أو أضف المتغيرين في Vercel ثم أعد المحاولة من اللوحة",
      ],
    }, 501)
  }

  const by = auth.user.email
  try {
    if (mode === "stop") {
      // 1) حالة رسمية: STOPPING (فورًا — لا تعتمد على أي workflow slot)
      await db.systemState.upsert({
        where: { id: SINGLETON },
        update: { state: "STOPPING", stoppedAt: new Date(), stoppedBy: by, reason: (body?.reason ?? "Emergency Stop من لوحة التحكم").slice(0, 300) },
        create: { id: SINGLETON, state: "STOPPING", stoppedAt: new Date(), stoppedBy: by, reason: (body?.reason ?? "Emergency Stop من لوحة التحكم").slice(0, 300) },
      })
      // 2) إنشاء الملف الرسمي — السلاسل بتراه في بدايتها وأثناء اللوب وقبل أي dispatch
      const cur = await getStopSha()
      if (!cur.exists) {
        const res = await ghApi(`/contents/.github/STOP`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "STOP — إيقاف رسمي من لوحة التحكم",
            content: Buffer.from(`STOP ${new Date().toISOString()} by ${by}\n`).toString("base64"),
          }),
        })
        if (res.status !== 200 && res.status !== 201) {
          await db.systemState.update({ where: { id: SINGLETON }, data: { state: "RUNNING", reason: `فشل إنشاء STOP: HTTP ${res.status}` } }).catch(() => undefined)
          return json({ ok: false, performed: false, reason: `GitHub رجّع HTTP ${res.status} عند إنشاء STOP — راجع صلاحيات التوكين` }, 502)
        }
      }
      // 3) تأكيد الانتشار: قراءة الملف تاني — ال existence هو الدليل
      const verify = await getStopSha()
      const propagated = verify.exists
      // 4) الحالة الرسمية النهائية
      await db.systemState.update({
        where: { id: SINGLETON },
        data: { state: propagated ? "STOPPED" : "STOPPING", stoppedAt: new Date(), stoppedBy: by, reason: (body?.reason ?? "Emergency Stop من لوحة التحكم").slice(0, 300) },
      })
      await db.auditLog.create({
        data: { workspaceId: auth.workspace.id, userId: auth.user.id, action: "SYSTEM_STOP", entityType: "System", entityId: "github-stop-file", after: { propagated, by, reason: (body?.reason ?? "").slice(0, 200) } },
      }).catch(() => undefined)
      return json({
        ok: propagated, performed: true, mode, state: propagated ? "STOPPED" : "STOPPING",
        propagation: {
          stopFileCreated: true,
          verifiedByReadback: propagated,
          chainsAffected: Object.keys(CHAINS),
          note: "السلاسل الستة بتقرأ STOP: عند البداية + أثناء اللوب (كل sweep/نبضة) + قبل أي dispatch. الجوب الشغالة بتكمل الخطوة الآمنة الحالية وتخرج — مفيش dispatch جديد.",
        },
      })
    }

    // ─── resume ───
    const cur = await getStopSha()
    if (cur.exists) {
      const res = await ghApi(`/contents/.github/STOP`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Resume — إزالة STOP من لوحة التحكم", sha: cur.sha }),
      })
      if (res.status !== 200) {
        return json({ ok: false, performed: false, reason: `GitHub رجّع HTTP ${res.status} عند حذف STOP` }, 502)
      }
    }
    const verify = await getStopSha()
    if (verify.exists) {
      return json({ ok: false, performed: false, reason: "فشل التحقق: STOP لسه موجود بعد الحذف — جرب تاني" }, 502)
    }

    // dispatch جيل واحد لكل سلسلة — عبر بوابة السعة (بدون عاصفة/بدون تكرار: كل سلسلة مرة واحدة هنا)
    const capacity = await capacityState()
    const dispatched: string[] = []
    const deferred: { chain: string; reason: string }[] = []
    for (const event of Object.keys(CHAINS) as ChainEvent[]) {
      const d = revivalDecision({ ...capacity, stop: false }, event)
      if (!d.allow) {
        deferred.push({ chain: CHAINS[event].name, reason: d.reason })
        continue
      }
      try {
        const res = await ghApi(`/dispatches`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event_type: event }),
        })
        if (res.status === 204) dispatched.push(CHAINS[event].name)
        else deferred.push({ chain: CHAINS[event].name, reason: `HTTP ${res.status}` })
      } catch (e) {
        deferred.push({ chain: CHAINS[event].name, reason: e instanceof Error ? e.message.slice(0, 80) : "خطأ" })
      }
    }

    await db.systemState.upsert({
      where: { id: SINGLETON },
      update: { state: "RUNNING", resumedAt: new Date(), resumedBy: by, stoppedAt: null, stoppedBy: null, reason: null },
      create: { id: SINGLETON, state: "RUNNING", resumedAt: new Date(), resumedBy: by },
    })
    await db.auditLog.create({
      data: { workspaceId: auth.workspace.id, userId: auth.user.id, action: "SYSTEM_RESUME", entityType: "System", entityId: "github-stop-file", after: { dispatched, deferred, by } },
    }).catch(() => undefined)

    return json({
      ok: true, performed: true, mode, state: "RUNNING",
      stopFileRemoved: true, verifiedByReadback: true,
      dispatched, deferred,
      note: deferred.length ? `السلاسل المؤجلة هتُحيا تلقائيًا بأول نبضة (supervisor) لما السعة تسمح` : "كل السلاسل انطلقت",
    })
  } catch (err) {
    return json({ ok: false, performed: false, reason: `فشل الاتصال بـGitHub: ${err instanceof Error ? err.message.slice(0, 100) : "خطأ"}` }, 502)
  }
}
