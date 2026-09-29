// LeadOS — System Control API: حالة النظام + مفتاح الإيقاف الرسمي (طلب #10)
// STOP = ملف .github/STOP في الريبو — كل الـworkflows بتفحصه (بداية/أثناء اللوب/قبل dispatch).
// زر الإيقاف من اللوحة بيكتبه عبر GitHub Contents API — ولو مفيش توكين، بنقول الحقيقة
// وندير الخطوة الدقيقة المطلوبة بدل ما نزوّر نجاح.
import { db } from "@/lib/db"
import { json, jsonError, requireAuth, isResponse, readBody } from "@/lib/api-helpers"

export const maxDuration = 30

function ghConf() {
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPO // صيغة: owner/name
  return { token, repo, ready: Boolean(token && repo) }
}

async function getStopSha(): Promise<{ exists: boolean; sha?: string; status: number }> {
  const { token, repo } = ghConf()
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/.github/STOP`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  })
  if (res.status === 200) {
    const d = (await res.json()) as { sha?: string }
    return { exists: true, sha: d.sha, status: 200 }
  }
  return { exists: false, status: res.status }
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

  const lastTick = await db.job.findFirst({ where: { type: "DISCOVERY", status: "SUCCESS" }, orderBy: { completedAt: "desc" }, select: { completedAt: true } }).catch(() => null)
  const runningJobs = await db.job.count({ where: { workspaceId: wsId, status: "RUNNING" } }).catch(() => 0)
  const failedJobs = await db.job.count({ where: { workspaceId: wsId, status: "FAILED", completedAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }).catch(() => 0)
  const activeGraphs = await db.taskGraph.count({ where: { workspaceId: wsId, status: "ACTIVE" } }).catch(() => 0)

  const ageMin = lastTick?.completedAt ? (Date.now() - lastTick.completedAt.getTime()) / 60_000 : null
  const systemState = stopFile === "EXISTS" ? "STOPPED" : ageMin === null ? "UNKNOWN" : ageMin <= 15 ? "RUNNING" : ageMin <= 60 ? "DEGRADED" : "IDLE"

  return json({
    ok: true,
    systemState,
    stopFile,
    stopControlReady: ready,
    stopHint: ready ? null : "لتفعيل زر الإيقاف من اللوحة: أضف متغيري GITHUB_TOKEN (Contents: read+write) و GITHUB_REPO (owner/name) في Vercel. أو أنشئ الملف يدويًا من واجهة GitHub: Add file → .github/STOP",
    metrics: { lastSuccessfulTick: lastTick?.completedAt ?? null, runningJobs, failedJobs24h: failedJobs, activeGraphs },
  })
}

export async function POST(req: Request) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  // منع الإيقاف الخطير بدون تأكيد صريح (طلب #10)
  const body = await readBody<{ confirm?: string; mode?: "stop" | "resume" }>(req)
  const mode = body?.mode === "resume" ? "resume" : "stop"
  if (mode === "stop" && body?.confirm !== "STOP") {
    return jsonError("التأكيد مطلوب: أرسل { confirm: \"STOP\", mode: \"stop\" } — الإيقاف يوقف كل السلاسل", 400)
  }
  const { token, repo, ready } = ghConf()
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

  try {
    const cur = await getStopSha()
    let httpStatus: number
    if (mode === "stop" && !cur.exists) {
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/.github/STOP`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "🛑 STOP — إيقاف رسمي من لوحة التحكم",
          content: Buffer.from(`STOP ${new Date().toISOString()} by ${auth.user.email}\n`).toString("base64"),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      httpStatus = res.status
    } else if (mode === "resume" && cur.exists) {
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/.github/STOP`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ message: "▶️ Resume — إزالة STOP من لوحة التحكم", sha: cur.sha }),
        signal: AbortSignal.timeout(15_000),
      })
      httpStatus = res.status
    } else {
      httpStatus = 200 // الحالة المطلوبة متحققة أصلًا
    }

    const performed = httpStatus === 200 || httpStatus === 201
    await db.auditLog.create({
      data: {
        workspaceId: auth.workspace.id,
        userId: auth.user.id,
        action: mode === "stop" ? "SYSTEM_STOP" : "SYSTEM_RESUME",
        entityType: "System",
        entityId: "github-stop-file",
        after: { httpStatus, performed },
      },
    }).catch(() => undefined)

    if (!performed) {
      return json({ ok: false, performed: false, reason: `GitHub رجّع HTTP ${httpStatus} — راجع صلاحيات التوكين (contents: write مطلوبة)` }, 502)
    }
    return json({ ok: true, performed: true, mode, stopFile: mode === "stop" ? "EXISTS" : "ABSENT" })
  } catch (err) {
    return json({ ok: false, performed: false, reason: `فشل الاتصال بـGitHub: ${err instanceof Error ? err.message.slice(0, 100) : "خطأ"}` }, 502)
  }
}
