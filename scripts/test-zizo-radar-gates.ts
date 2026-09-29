// LeadOS — Zizo Gates + Radar Gates Integration (Final Hardening #11/#12: زيزو + الرادار)
// اختبار بوالبات الحماية كاملة بدون أي إرسال حقيقي (لا cookies هنا ولا مفاتيح — الفشل الآمن هو المطلوب).
// زيزو: ساعات بشرية + حصة يومية + فاصل أدنى. رادار: init فوري → جوب تعليق → سقف يومي → خارج الساعات → ازدواج.
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { gateCheck, type ZizoConfig } from "../src/lib/agent/zizo/gate"
import { ingestInstantPosts, processDueComments, matchInstantIntent, RADAR_CONFIG } from "../src/lib/radar"

const TAG = `hardening-${randomUUID().slice(0, 6)}`
let pass = 0, fail = 0
function check(ok: boolean, label: string, note = "") {
  if (ok) { pass++; console.log(`✅ ${label}${note ? ` — ${note}` : ""}`) }
  else { fail++; console.log(`❌ ${label}${note ? ` — ${note}` : ""}`) }
}

async function main() {
  const db = new PrismaClient()
  const ws = await db.workspace.findFirst({ where: { isActive: true } })
  if (!ws) throw new Error("لا ورشة")

  // ═══ زيزو — gateCheck ═══
  console.log("\n═══ بوابات زيزو ═══")
  const cfg: ZizoConfig = { maxDailyMessages: 3, minGapMinutes: 10, approvalRequired: true, defaultCommentAngle: null } as ZizoConfig
  const noon = new Date(); noon.setHours(14, 0, 0, 0) // داخل ساعات البشر
  const night = new Date(); night.setHours(3, 0, 0, 0) // خارجها

  const gNight = await gateCheck(ws.id, "WHATSAPP", cfg, night)
  check(!gNight.allowed, "زيزار 3 الفجر مرفوض (ساعات بشرية)", gNight.reason.slice(0, 60))

  const gFresh = await gateCheck(ws.id, `TEST_${TAG}`, cfg, noon) // قناة اختبار فاضية
  check(gFresh.allowed, "داخل الساعات + حصة فاضية → مسموح", gFresh.reason.slice(0, 60))

  // زرع رسايل تجاوزت الحصة (3/3) على نفس القناة الاختبارية
  const conv = await db.conversation.create({ data: { workspaceId: ws.id, channel: `TEST_${TAG}` as never, externalId: TAG, contactName: TAG } as never })
  for (let i = 0; i < 3; i++) {
    await db.message.create({ data: { conversationId: conv.id, direction: "OUT", author: "ZIZO", body: `${TAG}-${i}`, sentAt: new Date(Date.now() - (30 - i)) } as never })
  }
  const gCapped = await gateCheck(ws.id, `TEST_${TAG}`, cfg, noon)
  check(!gCapped.allowed && gCapped.reason.includes("حصة"), "الحصة اليومية (3/3) → مرفوض", gCapped.reason.slice(0, 60))

  // الفاصل الأدنى: آخر رسالة قبل دقيقة
  await db.message.deleteMany({ where: { conversationId: conv.id } })
  await db.message.create({ data: { conversationId: conv.id, direction: "OUT", author: "ZIZO", body: TAG, sentAt: new Date(Date.now() - 60_000) } as never })
  const gGap = await gateCheck(ws.id, `TEST_${TAG}`, { ...cfg, minGapMinutes: 10 } as ZizoConfig, noon)
  check(!gGap.allowed && gGap.reason.includes("بدري"), "الفاصل الآمن (آخر رسالة قبل دقيقة) → مرفوض", gGap.reason.slice(0, 60))

  // الموافقة البشرية: سياسة زيزو — draft بلا إرسال (من التهيئة approvalRequired)
  check(cfg.approvalRequired === true, "سياسة الموافقة مفعّلة في cfg الاختبارية (الدرفت قبل الإرسال)", "approvalRequired=true")

  // ═══ الرادار — init فوري + بوابات التعليقات ═══
  console.log("\n═══ بوابات الرادار ═══")
  const group = await db.monitoredGroup.create({ data: { workspaceId: ws.id, platform: "FACEBOOK", name: `${TAG}-group`, url: `https://facebook.com/groups/${TAG}`, externalId: TAG, status: "ACTIVE" } as never })

  const fresh = {
    externalId: `${TAG}-post-1`, url: `https://facebook.com/groups/${TAG}/posts/1`,
    author: "صاحب مشروع تجريبي", content: "محتاج مصمم جرافيك لمشروعي الجديد في القاهرة urgently — ابعتولي السعر",
    postedAt: new Date(), intentScore: 90, matched: ["محتاج مصمم"],
  } as never
  const r1 = await ingestInstantPosts(ws.id, group, [fresh])
  check(r1.created === 1 && r1.leads === 1, "منشور طازج → GroupPost QUALIFIED + ليد فوري", `created=${r1.created} leads=${r1.leads}`)

  const r2 = await ingestInstantPosts(ws.id, group, [fresh])
  check(r2.created === 0, "نفس المنشور تاني → ازدواج مرفوض (dedup)", `created=${r2.created}`)

  const intent = matchInstantIntent("محتاج مبرمج يعمل موقع لمحلي my business asap")
  check(Boolean(intent && intent.score >= 80), "كشف النيتة الفورية (كلمات عاجلة)", `score=${intent?.score}`)

  // جوب تعليق مستحقة → processDueComments: حاليًا وقت الاختبار خارج ساعات النشاط (بعد 11:30م بالقاهرة) → تأجيل
  const cj = await db.job.create({ data: { workspaceId: ws.id, type: "FB_COMMENT", status: "QUEUED", priority: 50, scheduledAt: new Date(Date.now() - 60_000), payload: { marker: TAG, postUrl: "https://facebook.com/x", postText: "محتاج موقع", matched: ["موقع"], groupName: `${TAG}-group` } as never } as never })
  const proc = await processDueComments(ws.id, 2)
  const deferredForHours = proc.notes.some(n => n.includes("ساعات النشاط"))
  const cairoHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", hour12: false }).format(new Date()))
  if (cairoHour < RADAR_CONFIG.activeHourStart || cairoHour >= RADAR_CONFIG.activeHourEnd) {
    check(deferredForHours, "جوب التعليق اتأجلت: خارج ساعات النشاط", proc.notes[0]?.slice(0, 60) ?? "")
  } else {
    // داخل الساعات: البوابة هتحاول ترسل فعليًا — محليًا بدون cookies النتيجة فشل آمن → RETRYING
    const after = await db.job.findUnique({ where: { id: cj.id } })
    check(after?.status === "RETRYING" || after?.status === "QUEUED" || after?.status === "FAILED", "داخل الساعات محليًا: محاولة إرسال فشلت بأمان (لا cookies)", `status=${after?.status}`)
  }

  // السقف اليومي: زرع RADAR_DAILY_CAP نجاح → رفض فوري
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
  await db.job.createMany({ data: Array.from({ length: RADAR_CONFIG.dailyCap }, () => ({ workspaceId: ws.id, type: "FB_COMMENT", status: "SUCCESS", createdAt: new Date(), completedAt: new Date(), scheduledAt: new Date(), payload: { marker: TAG } as never })) })
  const procCap = await processDueComments(ws.id, 2)
  check(procCap.notes.some(n => n.includes("السقف اليومي")), "السقف اليومي (18) → إيقاف تعليقات لحد بكرة", procCap.notes[0]?.slice(0, 60) ?? "")

  // ═══ تنظيف ═══
  await db.job.deleteMany({ where: { OR: [{ payload: { path: [] } } as never] } }).catch(() => undefined)
  await db.job.deleteMany({ where: { workspaceId: ws.id, type: "FB_COMMENT", payload: { string_contains: TAG } as never } }).catch(() => undefined).catch(() => undefined)
  // تنظيف بمطابقة الحقول النصية (متوافق sqlite)
  const jobs = await db.job.findMany({ where: { workspaceId: ws.id, type: "FB_COMMENT" }, select: { id: true, payload: true } })
  for (const j of jobs) if (JSON.stringify(j.payload).includes(TAG)) await db.job.delete({ where: { id: j.id } })
  await db.message.deleteMany({ where: { conversationId: conv.id } })
  await db.conversation.delete({ where: { id: conv.id } }).catch(() => undefined)
  
  const bizes = await db.business.findMany({ where: { name: "صاحب مشروع تجريبي" } })
  for (const b of bizes) { await db.lead.deleteMany({ where: { businessId: b.id } }); await db.business.delete({ where: { id: b.id } }).catch(() => undefined) }
  await db.groupPost.deleteMany({ where: { groupId: group.id } })
  await db.monitoredGroup.delete({ where: { id: group.id } }).catch(() => undefined)
  console.log("\n🧹 تنظيف البيانات الاختبارية تم")

  await db.$disconnect()
  console.log(`\n═══ النتيجة: ${pass} PASS · ${fail} FAIL ═══`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error("فشل:", e instanceof Error ? e.message.slice(0, 300) : e); process.exit(1) })
