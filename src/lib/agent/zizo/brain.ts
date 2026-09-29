// LeadOS — عقل زيزو (بيع ذاتي مستمر)
// زيزو = كيان بيع: يرد على العملاء بطابع بشري 100%، يتابع الساكت، يبادر مع الليدز الحلوة،
// يحوّل الكلام لـ«لايف كول محجوز»، ويتعلم من كل تحوّل في المحادثات (ذاكرة دلالية مشتركة).
// الحلقة: رسالة عميل → رد بشري → متابعة ذكية → مبادرة → حجز → تعلّم.
import { db } from "@/lib/db"
import { aiChat, extractJson } from "@/lib/ai"
import { recordInsight, topInsights } from "@/lib/agent/memory"
import { marketBrief, ensureKnowledgeSeeded } from "./knowledge"
import { zizoPersona, HUMAN_RULES } from "./persona"
import { SERVICES_DIGEST, servicesHint, zizoConfigOf } from "./services"
import { humanize, type HumanOut } from "./humanize"
import { stageLine, pickOpener, detectBooked, inferStage, STAGES, type SaleStage } from "./playbook"
import { PSYCH_DOCTRINE, detectPsychContext } from "./psychology"
import { EXPERT_CORE, expertiseBrief, objectionBrief } from "./expertise"
import { recordTacticUse, evolutionTick } from "./evolution"
import { gateCheck } from "./gate"
import { gitSkillsTactics } from "@/lib/skills/gitskills"
import { hubTactics } from "@/lib/skills/hub"

const trunc = (s: unknown, n: number) => String(s ?? "").slice(0, n)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── إرسال واتساب (Evolution API) بتأخير كتابة بشري ───
function evolutionReady(): boolean {
  return Boolean(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY)
}
async function sendWhatsapp(phone: string, body: string, delayMs: number): Promise<boolean> {
  const base = process.env.EVOLUTION_API_URL
  const key = process.env.EVOLUTION_API_KEY
  if (!base || !key) return false
  const to = phone.replace(/[^\d]/g, "")
  if (!to) return false
  // التأخير البشري الحقيقي قبل الإرسال (سقف 8 ثواني عشان الحلقة متعلقش)
  await sleep(Math.min(delayMs, 8000))
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/message/sendText/${process.env.EVOLUTION_INSTANCE ?? "leados"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({ number: `${to}@s.whatsapp.net`, text: body }),
      signal: AbortSignal.timeout(15000),
    })
    return res.ok
  } catch {
    return false
  }
}

function detectLang(text: string): "ar" | "en" {
  return /[\u0600-\u06FF]/.test(text) ? "ar" : "en"
}

/** هل ردّ زيزو في اللغة الغلط؟ (كسر الطابع البشري — العميلة مصري بيرد إنجليزي تفكير = كارثة) */
function wrongLang(msgs: string[], lang: "ar" | "en"): boolean {
  const all = msgs.join(" ")
  if (!all) return false
  const latin = (all.match(/[A-Za-z]/g) ?? []).length
  const arabic = (all.match(/[\u0600-\u06FF]/g) ?? []).length
  const total = latin + arabic
  if (total < 20) return false
  return lang === "ar" ? latin / total > 0.45 : arabic / total > 0.45
}

// ─── قراءة المحادثة كسطر شات (للبرومبت) ───
function chatTranscript(msgs: Array<{ author: string; body: string; sentAt: Date }>): string {
  return msgs
    .map((m) => `${m.author === "CLIENT" ? "العميل" : m.author === "ZIZO" ? "زيزو" : "موظف"}: ${trunc(m.body, 220)}`)
    .join("\n")
}

interface ZizoDraft {
  msgs?: string[]
  stage?: string
  memo?: string
}

// ─── الرد الذكي: إدخال → رد بشري → حفظ → إرسال → تعلم ───
export async function zizoReply(wsId: string, conversationId: string): Promise<{
  ok: boolean
  note: string
  msgs: string[]
  delaysMs: number[]
  stage?: string
}> {
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    include: {
      lead: { include: { business: { select: { name: true, city: true, category: true } } } },
      messages: { orderBy: { sentAt: "asc" }, take: 30 },
    },
  })
  if (!conv || conv.workspaceId !== wsId) return { ok: false, note: "محادثة غير موجودة", msgs: [], delaysMs: [] }
  const wsSettings = (await db.workspace.findUnique({ where: { id: wsId }, select: { settings: true } }))?.settings
  const cfg = zizoConfigOf(wsSettings)

  const clientMsgs = conv.messages.filter((m) => m.author === "CLIENT")
  const lastClient = clientMsgs[clientMsgs.length - 1]?.body ?? ""
  const prevStage = conv.stage

  // ذاكرة زيزو: دروس البيع المتراكمة + ملاحظته عن العميل ده + معرفته بالسوق
  const insights = await topInsights(wsId, 6)
  const salesIns = insights.filter((i) => ["sales", "positive", "negative"].includes(i.kind))
  const market = marketBrief(`${lastClient} ${conv.memo ?? ""} ${conv.lead?.business?.category ?? ""}`)
  const memoryCtx = [
    conv.memo ? `ملاحظاتك عن العميل ده: ${conv.memo}` : "",
    market ? `معرفتك بصناعته (من خبرتك في السوق):
${market}` : "",
    salesIns.length
      ? `دروس بيع من تجاربك السابقة:\n${salesIns.map((i) => `• ${i.pattern} — ${i.note}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  const stageGuide = stageLine(prevStage, conv.lastReplyBy, conv.lastMsgAt)

  // التدريب النفسي: العقيدة دايماً + توجيه تكنيك-ب-تكنيك حسب رد العميل (أو حالة المتابعة)
  const isFollowup = !lastClient
  const psychHits = cfg.psychology ? detectPsychContext(lastClient, { followup: isFollowup }) : []
  const tacticId = psychHits[0]?.id
  const psychBlock = cfg.psychology
    ? `\n\n${PSYCH_DOCTRINE}${
        psychHits.length
          ? `\n\nالوضع النفسي دلوقتي — استخدم التكنيك ده (رد العميل ده سلوك نفسي مش كلام عادي):\n${psychHits
              .map((h) => `【${h.name}】\n${h.guidance}`)
              .join("\n\n")}`
          : ""
      }`
    : ""

  // خبرة البيع الميدانية: العقيدة دايماً + playbook مجالات العميل + توجيه تفاوضي لو فيه اعتراض
  const expertBlock = `\n\n${EXPERT_CORE}${
    expertiseBrief(lastClient) ? `\n\n${expertiseBrief(lastClient)}` : ""
  }${objectionBrief(lastClient) ? `\n\n${objectionBrief(lastClient)}` : ""}`

  // دروس ميدانية من المكتبتين العالميتين (GitSkills 3.8M مهارة + ClawHub منسّقة):
  // أعلى التكتيكات وزنًا في البيع/المتابعة بتدخل سياق زيزو — ومكتبته بتكبر مع كل حصاد
  const libNiche = `sales follow up closing objection whatsapp ${conv.lead?.business?.category ?? ""}`.trim()
  const [libGit, libHub] = await Promise.all([
    gitSkillsTactics("", libNiche, 2).catch(() => [] as string[]),
    hubTactics("", libNiche, 2).catch(() => [] as string[]),
  ])
  const libLines = [...(libGit ?? []), ...(libHub ?? [])]
  const tacticsBlock = libLines.length
    ? `\n\nتكتيكات ميدانية من مكتبة التكتيكات العالمية (استلهم أسلوبك منها من غير ما تنقلها حرفيًا):\n${libLines.join("\n")}`
    : ""

  const system = `${zizoPersona({
    agencyName: cfg.agencyName,
    servicesDigest: SERVICES_DIGEST,
    memoryCtx,
    stageLine: stageGuide,
  })}\n\n${HUMAN_RULES}${psychBlock}${expertBlock}${tacticsBlock}`
  const user = `المحادثة لحد دلوقتي:
${chatTranscript(conv.messages) || "(لسه مفيش رسايل)"}

${lastClient ? `آخر رسالة من العميل: «${trunc(lastClient, 300)}»` : "العميل لسه ما ردش — المطلوب متابعة منك."}
${servicesHint(lastClient || conv.memo || "")}
${conv.lang === "en" ? "العميل بيكتب إنجليزي — ردّ عليه إنجليزي بنفس الروح." : "ردّ بالمصري الشاتي."}

اكتب ردك (JSON حسب القواعد).`

  const res = await aiChat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { workspaceId: wsId, runType: "AGENT", task: "chat", maxTokens: 750, temperature: 0.75 },
  )
  if (!res) return { ok: false, note: "محرك الرد غير متاح حاليًا", msgs: [], delaysMs: [] }
  let draft = extractJson<ZizoDraft>(res.text)
  if (!draft?.msgs?.length) {
    // محاولة إنقاذ: لو رد نصي عادي استخدمه كرسالة واحدة
    const fallback = res.text.trim().split("\n").filter(Boolean).slice(0, 2)
    if (!fallback.length) return { ok: false, note: "رد غير مفهوم من المحرك", msgs: [], delaysMs: [] }
    draft = { msgs: fallback }
  }

  // فحص اللغة — رد بلغة العميل المكسرة (تفكير إنجليزي لمصري) = إعادة محاولة واحدة بحزم
  const convLang = (lastClient ? detectLang(lastClient) : (conv.lang as "ar" | "en")) || "ar"
  if (draft.msgs && wrongLang(draft.msgs, convLang)) {
    const res2 = await aiChat(
      [
        { role: "system", content: system },
        { role: "user", content: `${user}\n\n⚠ مهم جدًا: ردّك السابق كان في لغة غلط. اكتب ردّك حصريًا ${convLang === "ar" ? "بالعربي المصري الشاتي" : "بالإنجليزي البسيط"} — زي ما واحد شاطر بيتكلم في واتساب، من غير أي تفكير ظاهر.` },
      ],
      { workspaceId: wsId, runType: "AGENT", task: "chat", maxTokens: 750, temperature: 0.7 },
    )
    const draft2 = res2 ? extractJson<ZizoDraft>(res2.text) : null
    if (draft2?.msgs?.length && !wrongLang(draft2.msgs, convLang)) draft = draft2
  }

  const out: HumanOut = humanize(draft.msgs ?? [])
  if (!out.msgs.length) return { ok: false, note: "الرد طلع فاضي بعد التصفية", msgs: [], delaysMs: [] }

  // تسجيل التكتيك النفسي المستخدم — محرك التطور بيكريمه بعدين لو جاب نتيجة
  if (tacticId) await recordTacticUse(wsId, "reply", tacticId)

  // المرحلة والموعد — لو زيزو ما صرّحش بيها استنتجناها من كلامه (دراع أمان)
  const declared = STAGES.includes(draft.stage as SaleStage) ? draft.stage : null
  const inferred = inferStage(out.msgs, prevStage)
  const order = ["NEW", "ENGAGED", "INTERESTED", "OFFERED", "OBJECTION", "CALL_BOOKED", "LOST"]
  const dIdx = declared ? order.indexOf(declared) : -1
  const iIdx = order.indexOf(inferred)
  const nextStage = order[Math.max(dIdx, iIdx)] ?? prevStage
  const booked = detectBooked([...out.msgs, lastClient])

  // الإرسال عبر بوابة الإرسال البشري:
  // requireApproval=true → أي رسالة تطلع درافت مستني موافقة صاحب الوكالة (مفيش إرسال عشوائي)
  // الرد على عميل كلمنا (inbound) بيمر على البوابة: ساعات إنسان + سقف يومي + فجوة — واللي ترفضه يبقى درافت
  const phone = conv.channel === "WHATSAPP" ? conv.contactHandle ?? "" : ""
  const sentAt = new Date()
  let sentOk = 0
  let drafted = 0
  for (let i = 0; i < out.msgs.length; i++) {
    let ok = false
    let draft = false
    let account = "default"
    if (cfg.requireApproval) {
      draft = true
    } else {
      const gate = await gateCheck(wsId, conv.channel, cfg)
      account = gate.account
      if (gate.allowed && phone && evolutionReady()) ok = await sendWhatsapp(phone, out.msgs[i], out.delaysMs[i])
      else draft = true
    }
    if (ok) sentOk++
    else drafted++
    await db.message.create({
      data: {
        conversationId,
        direction: "OUT",
        author: "ZIZO",
        body: out.msgs[i],
        sentAt: new Date(sentAt.getTime() + i * 1000),
        deliverMs: out.delaysMs[i],
        meta: {
          ...(ok ? { sent: true, account } : draft ? { draft: true, pending: true } : phone ? { sent: false } : { manual: true }),
          ...(tacticId ? { tactic: tacticId } : {}),
        },
      },
    })
  }

  await db.conversation.update({
    where: { id: conversationId },
    data: {
      stage: nextStage,
      status: drafted > 0 ? "PENDING_APPROVAL" : "WAITING_CLIENT",
      memo: draft.memo ? trunc(`${conv.memo ? conv.memo + " • " : ""}${draft.memo}`, 400) : conv.memo,
      lastMsgAt: new Date(),
      lastReplyBy: "ZIZO",
      msgCount: { increment: out.msgs.length },
      bookedAt: booked ? conv.bookedAt ?? new Date() : conv.bookedAt,
      bookedNote: booked && !conv.bookedNote ? booked : conv.bookedNote,
      lang: lastClient ? detectLang(lastClient) : conv.lang,
    },
  })

  // ربط الليد: آخر تواصل + موعد المتابعة
  if (conv.leadId) {
    await db.lead.update({
      where: { id: conv.leadId },
      data: {
        lastContactedAt: new Date(),
        nextFollowUpAt: booked ? new Date(Date.now() + 36 * 3600_000) : new Date(Date.now() + 2 * 24 * 3600_000),
        nextBestAction: booked ? `لايف كول محجوز: ${trunc(booked, 120)}` : undefined,
      },
    }).catch(() => undefined)
  }

  // التعلّم: كل تحوّل مرحلي = درس تراكمي
  if (nextStage !== prevStage) {
    await recordInsight(
      wsId,
      "sales",
      `${prevStage}→${nextStage}`,
      draft.memo?.slice(0, 160) || `تحول محادثة من ${prevStage} لـ${nextStage}`,
      { conversationId, sentOk },
    )
  }

  return {
    ok: true,
    note: `${out.msgs.length} رسالة بشري${sentOk ? ` • ${sentOk} اتبعتت` : ""}${drafted ? ` • ${drafted} مستنية موافقتك` : ""} • ${prevStage}→${nextStage}`,
    msgs: out.msgs,
    delaysMs: out.delaysMs,
    stage: nextStage,
  }
}

// ─── مواعيد المتابعة الذكية (بشري: مش كل ساعة) ───
function followDueHours(stage: string): number {
  switch (stage) {
    case "OFFERED":
    case "OBJECTION":
      return 6
    case "INTERESTED":
      return 12
    case "ENGAGED":
      return 20
    default:
      return 22
  }
}

// ─── مبادرة تواصل جديدة مع ليد ───
export async function zizoOutreach(wsId: string, leadId: string): Promise<{ ok: boolean; note: string; conversationId?: string }> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: { business: { select: { name: true, city: true, category: true, phone: true } } },
  })
  if (!lead || lead.workspaceId !== wsId) return { ok: false, note: "ليد غير موجود" }
  const existing = await db.conversation.findFirst({ where: { workspaceId: wsId, leadId } })
  if (existing) return { ok: false, note: "عنده محادثة بالفعل", conversationId: existing.id }

  const cfg = zizoConfigOf((await db.workspace.findUnique({ where: { id: wsId } }))?.settings)
  const bizName = lead.business?.name ?? "العميل"
  const phone = lead.business?.phone ?? ""
  const channel = phone && evolutionReady() ? "WHATSAPP" : "MANUAL"
  const hint = (lead.summary || lead.serviceNeeds ? JSON.stringify(lead.serviceNeeds ?? []) : "") || lead.business?.category || ""

  const opener = pickOpener({
    agency: cfg.agencyName,
    name: bizName,
    industry: lead.business?.category ?? "",
    city: lead.business?.city ?? "",
    service: hint,
    hint: hint.slice(0, 60),
  })
  const out = humanize([opener])

  // المبادرة الباردة = أخطر رسالة على الحساب — افتراضيًا درافت مستني موافقة صاحب الوكالة
  const gate = await gateCheck(wsId, channel, cfg)
  const canSend = !cfg.requireApproval && channel === "WHATSAPP" && evolutionReady() && gate.allowed

  const conv = await db.conversation.create({
    data: {
      workspaceId: wsId,
      leadId,
      channel,
      contactName: bizName,
      contactHandle: phone || null,
      stage: "NEW",
      status: canSend ? "WAITING_CLIENT" : "PENDING_APPROVAL",
      memo: `مبادرة من زيزو — ليد سكور ${lead.score}`,
      lastReplyBy: canSend ? "ZIZO" : null,
      msgCount: out.msgs.length,
    },
  })
  let sentOk = 0
  for (let i = 0; i < out.msgs.length; i++) {
    const ok = canSend ? await sendWhatsapp(phone, out.msgs[i], out.delaysMs[i]) : false
    if (ok) sentOk++
    await db.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        author: "ZIZO",
        body: out.msgs[i],
        deliverMs: out.delaysMs[i],
        meta: ok ? { sent: true, account: gate.account } : { draft: true, pending: true },
      },
    })
  }
  if (sentOk) {
    await db.lead.update({
      where: { id: leadId },
      data: { lastContactedAt: new Date(), nextFollowUpAt: new Date(Date.now() + 22 * 3600_000) },
    }).catch(() => undefined)
  }
  await recordInsight(wsId, "sales", "outreach", `افتتاحية لـ${bizName} (${channel}${sentOk ? " • اتبعتت" : " • مستنية موافقة"})`, { leadId })
  return {
    ok: true,
    note: sentOk ? `مبادرة على ${bizName} — اتبعتت واتساب` : `درافت مبادرة لـ${bizName} — مستنية موافقتك قبل الإرسال`,
    conversationId: conv.id,
  }
}

// ─── إضافة رسالة عميل على محادثة موجودة (إنبوكس يدوي/محاكاة) ───
export async function addClientMessage(wsId: string, conversationId: string, body: string): Promise<boolean> {
  const text = body.trim()
  if (!text) return false
  const conv = await db.conversation.findFirst({ where: { id: conversationId, workspaceId: wsId } })
  if (!conv) return false
  await db.message.create({ data: { conversationId, direction: "IN", author: "CLIENT", body: text.slice(0, 2000) } })
  await db.conversation.update({
    where: { id: conversationId },
    data: { status: "NEEDS_REPLY", lastMsgAt: new Date(), lastReplyBy: "CLIENT", msgCount: { increment: 1 }, lang: detectLang(text) },
  })
  return true
}

// ─── النبضة الدائمة: يرد + يتابع + يبادر ───
export async function zizoTick(wsId: string): Promise<{ replies: number; followups: number; outreaches: number; note: string }> {
  await ensureKnowledgeSeeded(wsId) // لو ورشة جديدة — زيزو بيتعلم معرفة السوق قبل أول نبضة
  const cfg = zizoConfigOf((await db.workspace.findUnique({ where: { id: wsId } }))?.settings)
  let replies = 0
  let followups = 0
  let outreaches = 0

  // 1) محادثات مستنية رد من زيزو
  const needs = await db.conversation.findMany({
    where: { workspaceId: wsId, status: "NEEDS_REPLY" },
    orderBy: { lastMsgAt: "asc" },
    take: 6,
    select: { id: true },
  })
  for (const c of needs) {
    const r = await zizoReply(wsId, c.id)
    if (r.ok) replies++
    await sleep(1500)
  }

  // 2) متابعات: مقفولة افتراضيًا (ضد الإزعاج) — بتشتغل فقط لو صاحب الوكالة فعل autoFollowup
  if (cfg.autoFollowup) {
    const waiting = await db.conversation.findMany({
      where: { workspaceId: wsId, status: "WAITING_CLIENT", lastReplyBy: "ZIZO", stage: { in: ["NEW", "ENGAGED", "INTERESTED", "OFFERED", "OBJECTION"] } },
      orderBy: { lastMsgAt: "asc" },
      take: 14,
      select: { id: true, stage: true, lastMsgAt: true },
    })
    const now = Date.now()
    for (const c of waiting) {
      const due = followDueHours(c.stage)
      if (now - c.lastMsgAt.getTime() > due * 3600_000) {
        const r = await zizoReply(wsId, c.id)
        if (r.ok) followups++
        if (followups >= 4) break
        await sleep(1500)
      }
    }
  }

  // 3) مبادرات: مقفولة افتراضيًا — ولما تتفتح بتعمل درافتات للليدز اللي عندها طلب صريح بس
  const startOfDay = new Date(new Date().setHours(0, 0, 0, 0))
  const sentToday = await db.conversation.count({ where: { workspaceId: wsId, createdAt: { gte: startOfDay }, stage: "NEW", lastReplyBy: "ZIZO" } })
  if (cfg.autoOutreach && sentToday < cfg.maxDailyOutreach) {
    const candidates = await db.lead.findMany({
      where: {
        workspaceId: wsId,
        score: { gte: cfg.minOutreachScore },
        status: { in: ["NEW", "CONTACTED"] },
        conversations: { none: {} },
        // شرط الطلب الصريح: بس ليد عنده إشارة طلب حقيقي — ممنوع البث العشوائي
        OR: [
          { intentScore: { gte: 65 } },
          { intent: { contains: "طلب" } },
          { intent: { contains: "محتاج" } },
          { intent: { contains: "عايز" } },
        ],
      },
      orderBy: { score: "desc" },
      take: Math.min(cfg.maxDailyOutreach - sentToday, 4),
      select: { id: true },
    })
    for (const l of candidates) {
      const r = await zizoOutreach(wsId, l.id)
      if (r.ok) outreaches++
      await sleep(2500)
    }
  }

  const parts = [replies && `${replies} رد`, followups && `${followups} متابعة`, outreaches && `${outreaches} مبادرة`].filter(Boolean)

  // نبضة التطور الذاتي: تعلم من النتايج + إعادة أوزان + مقترحات جوهرية (مقفولة جوه بمعدل زمني)
  let evoNote = ""
  if (cfg.selfEvolution) {
    const evo = await evolutionTick(wsId).catch(() => null)
    if (evo?.learned?.length) evoNote = ` • تطور: اتعلم ${evo.learned.length} درس`
    if (evo?.proposal) evoNote += " • في مقترح مستني موافقتك"
  }

  return { replies, followups, outreaches, note: (parts.length ? parts.join(" • ") : "مفيش شغل مطلوب دلوقتي") + evoNote }
}

// ─── رسايل مستنية موافقة صاحب الوكالة (طبقة الموافقة) ───
export interface PendingItem {
  id: string
  channel: string
  contactName: string | null
  stage: string
  memo: string | null
  business: string | null
  score: number | null
  drafts: string[]
  lastMsgAt: Date
}

export async function pendingApprovals(wsId: string): Promise<PendingItem[]> {
  const convs = await db.conversation.findMany({
    where: { workspaceId: wsId, status: "PENDING_APPROVAL" },
    orderBy: { lastMsgAt: "desc" },
    take: 25,
    include: {
      lead: { select: { score: true, business: { select: { name: true, city: true } } } },
      messages: { orderBy: { sentAt: "asc" }, take: 10 },
    },
  })
  return convs
    .map((c) => ({
      id: c.id,
      channel: c.channel,
      contactName: c.contactName,
      stage: c.stage,
      memo: c.memo,
      business: c.lead?.business?.name ?? c.contactName,
      score: c.lead?.score ?? null,
      drafts: c.messages
        .filter((m) => m.direction === "OUT" && (m.meta as { draft?: boolean } | null)?.draft)
        .map((m) => m.body),
      lastMsgAt: c.lastMsgAt,
    }))
    .filter((c) => c.drafts.length > 0)
}

/** موافقة صاحب الوكالة → إرسال الدرافت عبر البوابة */
export async function approveDraft(wsId: string, conversationId: string): Promise<{ ok: boolean; note: string }> {
  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId: wsId },
    include: { messages: { orderBy: { sentAt: "asc" }, take: 50 } },
  })
  if (!conv) return { ok: false, note: "محادثة غير موجودة" }
  if (conv.status !== "PENDING_APPROVAL") return { ok: false, note: "مفيش حاجة مستنية موافقة هنا" }
  const drafts = conv.messages.filter((m) => m.direction === "OUT" && (m.meta as { draft?: boolean } | null)?.draft)
  if (!drafts.length) return { ok: false, note: "مفيش رسايل درافت" }

  const cfg = zizoConfigOf((await db.workspace.findUnique({ where: { id: wsId }, select: { settings: true } }))?.settings)
  const phone = conv.channel === "WHATSAPP" ? conv.contactHandle ?? "" : ""
  let sentOk = 0
  let blocked = ""
  for (let i = 0; i < drafts.length; i++) {
    const m = drafts[i]
    const gate = await gateCheck(wsId, conv.channel, cfg)
    if (!gate.allowed) {
      blocked = gate.reason
      break // البوابة مقفولة — الباقي يفضل درافت
    }
    const ok = phone && evolutionReady() ? await sendWhatsapp(phone, m.body, Math.min(2500 + i * 4000, 8000)) : false
    if (ok) sentOk++
    await db.message.update({
      where: { id: m.id },
      data: { meta: ok ? { sent: true, account: gate.account, approved: true } : { draft: true, pending: true, blocked: gate.reason } },
    })
  }

  const remaining = drafts.length - sentOk
  await db.conversation.update({
    where: { id: conv.id },
    data: {
      status: remaining > 0 ? "PENDING_APPROVAL" : "WAITING_CLIENT",
      lastMsgAt: new Date(),
      ...(remaining === 0 ? { lastReplyBy: "ZIZO" } : {}),
    },
  })
  if (sentOk && conv.leadId) {
    await db.lead
      .update({ where: { id: conv.leadId }, data: { lastContactedAt: new Date(), nextFollowUpAt: new Date(Date.now() + 22 * 3600_000) } })
      .catch(() => undefined)
  }
  const note = sentOk
    ? `اتبعتت ${sentOk}/${drafts.length}${remaining ? ` — الباقي: ${blocked}` : " — تمام"}`
    : `متبعتش: ${blocked || "القناة مش متصلة (محتاج Evolution API أو القناة يدوي)"}`
  return { ok: sentOk > 0, note }
}

/** رفض صاحب الوكالة → الدرافت يتشال والمحادثة تتقفل */
export async function rejectDraft(wsId: string, conversationId: string): Promise<{ ok: boolean; note: string }> {
  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId: wsId },
    include: { messages: { take: 50 } },
  })
  if (!conv) return { ok: false, note: "محادثة غير موجودة" }
  const drafts = conv.messages.filter((m) => m.direction === "OUT" && (m.meta as { draft?: boolean } | null)?.draft)
  for (const m of drafts) {
    await db.message.update({ where: { id: m.id }, data: { meta: { draft: true, rejected: true } } })
  }
  await db.conversation.update({
    where: { id: conv.id },
    data: { status: "CLOSED", memo: trunc(`${conv.memo ? conv.memo + " • " : ""}مرفوضة يدويًا من صاحب الوكالة`, 400) },
  })
  return { ok: true, note: `اترفضت ${drafts.length} رسالة — المحادثة اتقفلت` }
}

// ─── حالة زيزو للواجهة ───
export async function zizoStatus(wsId: string) {
  const [open, needsReply, waiting, booked, lost, pending, byStage, fuel, convs] = await Promise.all([
    db.conversation.count({ where: { workspaceId: wsId, status: { in: ["OPEN", "NEEDS_REPLY", "WAITING_CLIENT"] } } }),
    db.conversation.count({ where: { workspaceId: wsId, status: "NEEDS_REPLY" } }),
    db.conversation.count({ where: { workspaceId: wsId, status: "WAITING_CLIENT" } }),
    db.conversation.count({ where: { workspaceId: wsId, bookedAt: { not: null } } }),
    db.conversation.count({ where: { workspaceId: wsId, stage: "LOST" } }),
    db.conversation.count({ where: { workspaceId: wsId, status: "PENDING_APPROVAL" } }),
    db.conversation.groupBy({ by: ["stage"], where: { workspaceId: wsId }, _count: true }),
    db.lead.count({ where: { workspaceId: wsId, score: { gte: 60 }, conversations: { none: {} }, status: { in: ["NEW", "CONTACTED"] } } }),
    db.conversation.findMany({
      where: { workspaceId: wsId },
      orderBy: { lastMsgAt: "desc" },
      take: 12,
      select: {
        id: true, contactName: true, channel: true, stage: true, status: true, lastMsgAt: true,
        msgCount: true, bookedAt: true, memo: true,
        lead: { select: { score: true, business: { select: { name: true, city: true } } } },
      },
    }),
  ])
  return {
    open, needsReply, waiting, booked, lost, pending, fuel,
    stages: byStage.map((s) => ({ stage: s.stage, count: s._count })),
    conversations: convs,
    whatsapp: evolutionReady(),
  }
}

// ─── إنشاء محادثة جديدة (إنبوكس يدوي أو من واتساب وارد) ───
export async function openConversation(
  wsId: string,
  input: { leadId?: string; channel?: string; externalId?: string; contactName?: string; contactHandle?: string; firstMessage?: string },
): Promise<{ id: string; needsReply: boolean }> {
  const contactName = input.contactName?.trim() || (input.leadId ? (await db.lead.findUnique({ where: { id: input.leadId }, select: { business: { select: { name: true } } } }))?.business?.name ?? null : null)
  const first = input.firstMessage?.trim()
  const conv = await db.conversation.create({
    data: {
      workspaceId: wsId,
      leadId: input.leadId || null,
      channel: input.channel || "MANUAL",
      externalId: input.externalId || null,
      contactHandle: input.contactHandle || null,
      contactName,
      status: first ? "NEEDS_REPLY" : "OPEN",
      lastMsgAt: new Date(),
      lastReplyBy: first ? "CLIENT" : null,
      msgCount: first ? 1 : 0,
      lang: first ? detectLang(first) : "ar",
    },
  })
  if (first) {
    await db.message.create({ data: { conversationId: conv.id, direction: "IN", author: "CLIENT", body: first } })
  }
  return { id: conv.id, needsReply: Boolean(first) }
}
