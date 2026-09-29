// LeadOS — System Alert Engine (Final Hardening #21)
// تنبيهات النظام الحقيقية بمستويات CRITICAL/HIGH/MEDIUM — بتتولد من فحص حي في النبضة، مش static.
// Dedup: نفس النوع مايتكررش قبل ما يعدي cooldown — عشان مايغرقش اللوحة.
import { db } from "@/lib/db"

interface Candidate {
  type: string
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO"
  title: string
  message: string
  actionUrl?: string
}

const COOLDOWN_MIN: Record<string, number> = {
  QUEUE_BACKLOG: 60, STALE_JOBS: 60, DISCOVERY_STALLED: 60, NEON_UNAVAILABLE: 30,
  INGEST_SILENCE: 90, SOURCE_ERRORING: 90, SYSTEM_STOPPED: 240,
}

/** فحوصات حية بعد كل نبضة — بتنشئ Alert لو الحالة لسه قايمة وعدى الـcooldown. */
export async function recordSystemAlerts(wsId: string): Promise<number> {
  const candidates: Candidate[] = []
  try {
    // 1) طابور متراكم
    const backlog = await db.job.count({ where: { workspaceId: wsId, status: { in: ["QUEUED", "RETRYING"] } } })
    if (backlog >= 20) candidates.push({ type: "QUEUE_BACKLOG", severity: "HIGH", title: "طابور متراكم", message: `${backlog} جوبة منتظرة — أعلى من الحد الآمن (20). افحص الطابور.`, actionUrl: "/queue" })
    // 2) جوبات عالقة (locks قديمة)
    const stale = await db.job.count({ where: { workspaceId: wsId, status: "RUNNING", lockedAt: { lt: new Date(Date.now() - 15 * 60_000) } } })
    if (stale > 0) candidates.push({ type: "STALE_JOBS", severity: "HIGH", title: "جوبات عالقة", message: `${stale} جوبة مأخوذة من عامل توقف عن الرد أكتر من 15 دقيقة — الـrecovery هيرجعها تلقائيًا.`, actionUrl: "/queue" })
    // 3) الاكتشاف واقف؟ (آخر DISCOVERY ناجح)
    const lastDiscovery = await db.job.findFirst({ where: { workspaceId: wsId, type: "DISCOVERY", status: "SUCCESS" }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } })
    if (!lastDiscovery || Date.now() - lastDiscovery.updatedAt.getTime() > 90 * 60_000) {
      candidates.push({ type: "DISCOVERY_STALLED", severity: "HIGH", title: "الاكتشاف واقف", message: `آخر DISCOVERY ناجح من ${lastDiscovery ? Math.round((Date.now() - lastDiscovery.updatedAt.getTime()) / 60000) + " دقيقة" : "الأبد"} — افحص السلاسل/السعة.`, actionUrl: "/health" })
    }
    // 4) صمت الابتلاع (مافيش محتوى جديد فترة طويلة)
    const lastItem = await db.contentItem.findFirst({ where: { workspaceId: wsId }, orderBy: { collectedAt: "desc" }, select: { collectedAt: true } })
    if (lastItem && Date.now() - lastItem.collectedAt.getTime() > 3 * 60 * 60_000) {
      candidates.push({ type: "INGEST_SILENCE", severity: "MEDIUM", title: "صمت ابتلاع", message: "مافيش محتوى جديد من أكتر من 3 ساعات — المزرعة أو المصادر ممكن تكون متعطلة.", actionUrl: "/ops" })
    }
    // 5) مصادر بتضرب أخطاء متكررة
    const erring = await db.source.count({ where: { workspaceId: wsId, status: "ACTIVE", lastError: { not: null }, lastRunAt: { lt: new Date(Date.now() - 2 * 60 * 60_000) } } })
    if (erring >= 3) candidates.push({ type: "SOURCE_ERRORING", severity: "MEDIUM", title: "مصادر بتفشل", message: `${erring} مصادر نشطة على خطأ وآخر تشغيل قديم — راجع مركز الصحة.`, actionUrl: "/sources" })
    // 6) النظام موقوف رسميًا (تذكير INFO للوعي)
    const sys = await db.systemState.findUnique({ where: { id: "singleton" } })
    if (sys && (sys.state === "STOPPED" || sys.state === "STOPPING")) {
      candidates.push({ type: "SYSTEM_STOPPED", severity: "INFO", title: "النظام موقوف", message: `الحالة ${sys.state} بواسطة ${sys.stoppedBy ?? "—"} — السلاسل واقفة لحد START.`, actionUrl: "/" })
    }
  } catch {
    // 7) Neon نفسها مش متاحة = CRITICAL فوري
    candidates.push({ type: "NEON_UNAVAILABLE", severity: "CRITICAL", title: "قاعدة البيانات مش متاحة", message: "فشل استعلام Neon أثناء فحص التنبيهات — النظام مش قادر يقرأ/يكتب.", actionUrl: "/health" })
  }
  let created = 0
  for (const c of candidates) {
    const cooldownMs = (COOLDOWN_MIN[c.type] ?? 60) * 60_000
    const recent = await db.alert.findFirst({
      where: { workspaceId: wsId, type: c.type, createdAt: { gte: new Date(Date.now() - cooldownMs) } },
      select: { id: true },
    })
    if (recent) continue
    await db.alert.create({
      data: { workspaceId: wsId, type: c.type, severity: c.severity, title: c.title, message: c.message, actionUrl: c.actionUrl },
    })
    created++
  }
  return created
}
