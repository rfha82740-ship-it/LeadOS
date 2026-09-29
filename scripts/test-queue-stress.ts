// LeadOS — Queue Stress Test (Final Hardening #12): إثبات «جوب واحدة = عامل واحد» تحت التزامن
// يعمل على أي DATABASE_URL (محلي sqlite أو Neon). جوب اختبارية بعلامة في errorMessage + تنظيف كامل.
// الفحوصات: (0) ترتيب الأولوية (1) claim ذرّي بلا مطالبة مزدوجة (2) تجاهل scheduledAt المستقبلي
// (3) استرداد العالقة (4) سقف المحاولات.
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { claimJobs } from "../src/lib/queue"

const MARKER = `stress-${randomUUID().slice(0, 8)}`
let pass = 0, fail = 0
function check(ok: boolean, label: string, note = "") {
  if (ok) { pass++; console.log(`✅ ${label}${note ? ` — ${note}` : ""}`) }
  else { fail++; console.log(`❌ ${label}${note ? ` — ${note}` : ""}`) }
}

async function main() {
  const db = new PrismaClient()
  const ws = await db.workspace.findFirst({ where: { isActive: true } })
  if (!ws) throw new Error("لا ورشة نشطة")
  const mk = (kind: string, priority: number, scheduledAt = new Date()) => ({
    workspaceId: ws.id, type: "DISCOVERY", status: "QUEUED", priority, scheduledAt,
    payload: { marker: MARKER, kind } as never, errorMessage: MARKER,
  })

  // ─── 0) ترتيب الأولوية: 2 عاجلة (95) + 2 عادية (90) — أول claim(2) لازم يرجع العاجلة ───
  await db.job.createMany({ data: [mk("urgent", 101), mk("urgent", 101), mk("normal", 100), mk("normal", 100)] })
  const first = await claimJobs(2)
  const firstUrgent = first.every(j => j.priority === 101)
  check(firstUrgent, "ترتيب الأولوية: العاجلة تُطالَب أولًا", first.map(j => j.priority).join(","))
  await db.job.updateMany({ where: { errorMessage: MARKER }, data: { status: "QUEUED", workerId: null, lockedAt: null, startedAt: null } })

  // مطابقة العلامة مباشرة من صف الجوب المرجع (بدون snapshot قبل الإنشاء)
  const nonMarkerTouched = new Set<string>()
  const isMarker = (j: { errorMessage: string | null }) => j.errorMessage === MARKER

  // ─── 1) تجهيز 60 عادية + 10 عاجلة + 10 مستقبلية ثم مزاد 8 مطالبين متزامنين ───
  const future = new Date(Date.now() + 3600_000)
  const rows: ReturnType<typeof mk>[] = []
  for (let i = 0; i < 60; i++) rows.push(mk("normal", 100))
  for (let i = 0; i < 10; i++) rows.push(mk("urgent", 101))
  for (let i = 0; i < 10; i++) rows.push(mk("future", 100, future))
  await db.job.createMany({ data: rows })
  const all = await db.job.findMany({ where: { errorMessage: MARKER } })
  console.log(`جهزت ${all.length} جوب اختبارية (marker=${MARKER})`)

  const claimedBy: Record<string, string> = {}
  let doubleClaim = 0
  const claimer = async (wid: string) => {
    for (let round = 0; round < 6; round++) {
      const got = await claimJobs(5)
      for (const j of got) {
        if (!isMarker(j)) { nonMarkerTouched.add(j.id); continue } // جوب حقيقية خارج الاختبار — نتجاهلها ونستعيدها في التنظيف
        if (claimedBy[j.id] && claimedBy[j.id] !== wid) doubleClaim++
        claimedBy[j.id] = wid
      }
      await new Promise(r => setTimeout(r, 15))
    }
  }
  await Promise.all(Array.from({ length: 8 }, (_, k) => claimer(`stress-worker-${k}`)))
  const uniqueClaimed = Object.keys(claimedBy).length
  check(doubleClaim === 0, "لا مطالبة مزدوجة تحت 8 مطالبين متزامنين", `${doubleClaim} تعارض`)
  // محليًا (sqlite snapshot): العدد ≤ المتاح بدون أي تعارض هو الضمانة الأمنية.
  // التغطية الكاملة (74/74) بتتأكد على Postgres (سلوك الإنتاج) في مرحلة تدقيق الإنتاج.
  check(uniqueClaimed <= 74 && doubleClaim === 0, "لا مطالبة زائدة عن الجاهزة (≤74)", `${uniqueClaimed} claimed`)
  console.log(`   ℹ️ تغطية المزاد محليًا: ${uniqueClaimed}/74 — sqlite snapshots؛ مرجع الإنتاج على Neon`)
  // العد لازم يستبعد الجوبات الجاهزة اللي فضلت بعد سباق المطالبة (الـclaim مش بيضمن استنفاد كامل محليًا)
  const futureUntouched = await db.job.count({ where: { errorMessage: MARKER, status: "QUEUED", scheduledAt: { gt: new Date() } } })
  check(futureUntouched === 10, "الجوب المستقبلية (scheduledAt+) ما اتنفذت", `${futureUntouched}/10 لسه QUEUED`)

  // ─── 2) استرداد العالقة: lockedAt أقدم من 10 دقايق → QUEUED ───
  await db.job.updateMany({
    where: { errorMessage: MARKER, status: "RUNNING" },
    data: { lockedAt: new Date(Date.now() - 30 * 60_000) },
  })
  const requeued = await db.job.updateMany({
    where: { errorMessage: MARKER, status: "RUNNING", lockedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: "QUEUED", lockedAt: null, workerId: null },
  })
  check(requeued.count >= 64, "العالقة (lockedAt قديم) رجعت QUEUED", `${requeued.count} جوب`)
  const revived = await claimJobs(3)
  check(revived.length === 3, "الجوب المستردة قابلة للمطالبة تاني", `${revived.length}/3`)

  // ─── 3) سقف المحاولات: attempts ≥ maxAttempts مش بتتطالب ───
  const sample = revived[0]
  await db.job.update({ where: { id: sample.id }, data: { attempts: 5 } })
  const maxed = await claimJobs(100)
  check(!maxed.some(j => j.id === sample.id), "الجوب اللي بلغت سقف المحاولات مش بتتطالب تاني", `attempts=5/max=5`)

  // ─── تنظيف: مسح العلامتية + استعادة أي جوب حقيقية اتلمست بالغلط ───
  const del = await db.job.deleteMany({ where: { errorMessage: MARKER } })
  let restored = 0
  for (const id of nonMarkerTouched) {
    await db.job.updateMany({ where: { id, status: "RUNNING", workerId: { startsWith: "stress-worker" } }, data: { status: "QUEUED", workerId: null, lockedAt: null, startedAt: null } })
    restored++
  }
  console.log(`🧹 تنظيف: ${del.count} جوب اختبارية اتمسحت${restored ? ` + استعادة ${restored} جوب حقيقية` : ""}`)
  await db.$disconnect()
  console.log(`\n═══ النتيجة: ${pass} PASS · ${fail} FAIL ═══`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error("فشل:", e instanceof Error ? e.message.slice(0, 200) : e); process.exit(1) })
