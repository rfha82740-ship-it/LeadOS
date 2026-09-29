// LeadOS — Lead Scoring Engine (doc §14)
// Score 0-100: Intent 30, BusinessFit 20, DecisionMaker 15, Urgency 10,
//              RecentActivity 10, Contactability 5, OpportunityStrength 10
// مصدر الحقيقة الوحيد للـLead score: calculateLeadScore — أي مكان محتاج معادلة التقييم
// بينادي دي (أو recomputeLeadScore للحساب+الحفظ). ممنوع معادلة مكررة في ملف تاني.
import type { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { asArray, temperatureFromScore } from "@/lib/constants"

export interface ScoreBreakdown {
  total: number
  parts: Record<string, number>
  temperature: string
}

interface ScoreInput {
  intentScore: number        // 0-100
  fitScore: number           // 0-100 (business fit: has website? reviews? industry target?)
  isDecisionMaker: boolean   // person is decision maker
  urgencyScore: number       // 0-100
  recentActivityDays: number // days since last signal
  hasContact: boolean        // phone/email/whatsapp available
  opportunityScore: number   // 0-100 (max opportunity strength)
}

/** المعادلة الرسمية الموحدة للنتيجة — قابل للتفسير: breakdown بأجزاء مسماة + whyNow/nextBestAction أعلى */
export function calculateLeadScore(input: ScoreInput): ScoreBreakdown {
  const parts: Record<string, number> = {}
  parts.intent = Math.round((input.intentScore / 100) * 30)
  parts.businessFit = Math.round((input.fitScore / 100) * 20)
  parts.decisionMaker = input.isDecisionMaker ? 15 : input.isDecisionMaker === false ? 6 : 8
  parts.urgency = Math.round((input.urgencyScore / 100) * 10)
  parts.recentActivity = input.recentActivityDays <= 1 ? 10 : input.recentActivityDays <= 3 ? 7 : input.recentActivityDays <= 7 ? 4 : 1
  parts.contactability = input.hasContact ? 5 : 0
  parts.opportunityStrength = Math.round((input.opportunityScore / 100) * 10)
  const total = Object.values(parts).reduce((a, b) => a + b, 0)
  return { total, parts, temperature: temperatureFromScore(total) }
}

/** اسم قديم محفوظ للتوافق — كل الكود بينادي calculateLeadScore الآن */
export const computeScore = calculateLeadScore

/** Recompute score for a lead based on its relations, persist, and log activity. */
export async function recomputeLeadScore(leadId: string, opts?: { workspaceId?: string }): Promise<ScoreBreakdown | null> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: {
      person: true,
      business: { include: { reviews: true, websites: true } },
      opportunities: { where: { status: { in: ["OPEN", "QUALIFIED", "PROPOSED"] } } },
      researchRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      contentLinks: { include: { content: true }, orderBy: { createdAt: "desc" }, take: 5 },
    },
  })
  if (!lead) return null

  const now = Date.now()
  const lastSignal = lead.contentLinks[0]?.content?.collectedAt ?? lead.lastSeenAt
  const recentDays = Math.max(0, Math.floor((now - new Date(lastSignal).getTime()) / 86400000))

  const oppScore = lead.opportunities.reduce((mx, o) => Math.max(mx, o.score), 0)
  const hasContact = Boolean(lead.business?.phone || lead.business?.email || lead.business?.websiteUrl || lead.person?.email || lead.person?.phone)

  // Business fit: rating & reviews & digital gaps
  let fit = 40
  const biz = lead.business
  if (biz) {
    if ((biz.reviewCount ?? 0) >= 200) fit += 20
    else if ((biz.reviewCount ?? 0) >= 50) fit += 12
    if ((biz.rating ?? 0) >= 4) fit += 15
    if (!biz.websiteUrl) fit += 15 // no website = big opportunity
  }

  const breakdown = computeScore({
    intentScore: lead.intentScore,
    fitScore: Math.min(100, fit),
    isDecisionMaker: lead.person?.isDecisionMaker ?? false,
    urgencyScore: lead.urgencyScore,
    recentActivityDays: recentDays,
    hasContact,
    opportunityScore: oppScore,
  })

  await db.lead.update({
    where: { id: leadId },
    data: { score: breakdown.total, temperature: breakdown.temperature as never },
  })
  if (opts?.workspaceId) {
    await db.activity
      .create({
        data: {
          workspaceId: opts.workspaceId,
          leadId,
          type: "AI_ACTION",
          subject: "تحديث Lead Score",
          body: `تم إعادة حساب النتيجة: ${breakdown.total} (${breakdown.temperature})`,
          metadata: { parts: breakdown.parts } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined)
    // Hot-lead alert (doc §33)
    if (breakdown.total >= 90) {
      const existingAlert = await db.alert.findFirst({
        where: { workspaceId: opts.workspaceId, type: "HOT_LEAD", actionUrl: `/lead/${leadId}` },
      })
      if (!existingAlert) {
        await db.alert.create({
          data: {
            workspaceId: opts.workspaceId,
            type: "HOT_LEAD",
            title: "Lead ساخن جديد!",
            message: `${lead.business?.name ?? lead.summary ?? "Lead"} حقق Score ${breakdown.total} — جاهز للتواصل فورًا`,
            severity: "CRITICAL",
            actionUrl: `/lead/${leadId}`,
            metadata: { leadId },
          },
        })
      }
    }
  }
  return breakdown
}
