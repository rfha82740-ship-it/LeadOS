// مسح جروبات فيسبوك محليًا بكود المشروع الحقيقي — scanDueGroups مباشرة
// التشغيل: npx tsx scripts/fb-scan-local.ts [عدد الجروبات]
// ملاحظة: ممنوع dotenv هنا — .env المحلي فيه sqlite وهو هيغلط الإنتاج
async function main() {
  // 1) حمّل الكوكيز ورابط الإنتاج دايمًا من الملفات الآمنة (تجاوز أي .env محلي)
  const fs = require("fs")
  if (!process.env.FACEBOOK_SESSION_COOKIE) {
    const line = fs
      .readFileSync("/home/z/my-project/.env.local", "utf8")
      .split("\n")
      .find((l: string) => l.startsWith("FACEBOOK_SESSION_COOKIE="))
    if (!line) throw new Error("مفيش FACEBOOK_SESSION_COOKIE في .env.local")
    process.env.FACEBOOK_SESSION_COOKIE = line.split("=").slice(1).join("=")
  }
  { // DATABASE_URL يتحدد دايمًا من .tokens (تجاهل .env المحلي)
    const line = fs
      .readFileSync("/home/z/my-project/scripts/deploy/.tokens", "utf8")
      .split("\n")
      .find((l: string) => l.startsWith("DATABASE_URL="))
    if (!line) throw new Error("مفيش DATABASE_URL في .tokens")
    process.env.DATABASE_URL = line.split("=").slice(1).join("=").replace(/^"|"$/g, "")
  }

  const limit = Number(process.argv[2] || "5")
  const { scanDueGroups } = await import("../src/lib/monitors/scan")

  // workspaceId من قاعدة البيانات
  const { db } = await import("../src/lib/db")
  const ws = await (db as { workspace: { findFirst: (a: unknown) => Promise<{ id: string } | null> } }).workspace.findFirst({
    select: { id: true },
  })
  if (!ws) throw new Error("مفيش workspace")

  console.log(`🚀 مسح ${limit} جروبات (workspace: ${ws.id})`)
  const outcomes = await scanDueGroups(ws.id, limit)
  for (const o of outcomes) {
    console.log(`   ${o.status === "OK" ? "✅" : "❌"} ${o.name.slice(0, 45)} | ${o.status} | بوستات جديدة: ${o.newPosts}${o.note ? ` | ${o.note.slice(0, 80)}` : ""}`)
  }
  const total = outcomes.reduce((a, o) => a + o.newPosts, 0)
  console.log(`== المجموع: ${total} بوست جديد من ${outcomes.length} جروب ==`)

  // ══ التحويل التلقائي: بوستات مؤهلة (score>=75) → عملاء في اللوحة ══
  // نفس منطق /api/groups/posts/[id]/convert — بدون Activity (مش محتاج userId)
  const { temperatureFromScore } = await import("../src/lib/constants")
  const { detectServiceKeys } = await import("../src/lib/monitors/segments")
  const dbx = db as unknown as {
    groupPost: {
      findMany: (a: unknown) => Promise<Array<{
        id: string; content: string; score: number; author: string | null; url: string | null
        group: { id: string; name: string; platform: string; url: string; workspaceId: string }
      }>>
      update: (a: unknown) => Promise<unknown>
    }
    business: { create: (a: unknown) => Promise<{ id: string }> }
    lead: { create: (a: unknown) => Promise<{ id: string }> }
    leadSource: { create: (a: unknown) => Promise<unknown> }
  }
  const qualified = await dbx.groupPost.findMany({
    where: { status: "QUALIFIED", leadId: null, group: { workspaceId: ws.id } },
    include: { group: { select: { id: true, name: true, platform: true, url: true, workspaceId: true } } },
    orderBy: { score: "desc" },
    take: 20,
  })
  let converted = 0
  for (const post of qualified) {
    try {
      const services = detectServiceKeys(post.content)
      const isCafe = /كافيه|كافي|قهوه|كوفي|مقهى|مقاهي|coffee|cafe/i.test(`${post.content} ${post.group.name}`)
      const hasAgencyNeed = services.length > 0
      const segment = isCafe ? (hasAgencyNeed ? "BOTH" : "CARDS") : "AGENCY"
      const name = (post.author?.trim() || `عميل من ${post.group.name}`).slice(0, 90)
      const business = await dbx.business.create({
        data: {
          workspaceId: ws.id,
          name,
          category: isCafe ? "cafe" : null,
          industry: isCafe ? "cafe" : null,
          metadata: { fromGroupPost: true },
        },
      })
      const score = Math.max(40, post.score)
      const lead = await dbx.lead.create({
        data: {
          workspaceId: ws.id,
          businessId: business.id,
          leadSourceType: "SOCIAL",
          segment,
          status: "NEW",
          temperature: temperatureFromScore(score),
          intent: score >= 80 ? "VERY_HIGH" : score >= 60 ? "HIGH" : "MEDIUM",
          score,
          intentScore: score,
          confidenceScore: 60,
          serviceNeeds: services,
          summary: post.content.slice(0, 400),
          whyNow: `منشور حديث في «${post.group.name}» (${post.group.platform})`,
          nextBestAction: "تواصل مع صاحب المنشور واعرض الحل المناسب",
          metadata: {
            groupPostId: post.id,
            groupId: post.group.id,
            groupName: post.group.name,
            groupUrl: post.group.url,
            platform: post.group.platform,
            postUrl: post.url,
            author: post.author,
            autoConverted: true,
          },
        },
      })
      await dbx.leadSource.create({
        data: {
          leadId: lead.id,
          sourceType: post.group.platform === "FACEBOOK" ? "FACEBOOK" : post.group.platform === "REDDIT" ? "REDDIT" : post.group.platform === "TELEGRAM" ? "TELEGRAM" : "OTHER",
          sourceUrl: post.url ?? post.group.url,
          label: `جروب: ${post.group.name}`,
        },
      })
      await dbx.groupPost.update({ where: { id: post.id }, data: { status: "CONVERTED", leadId: lead.id } })
      converted++
      console.log(`   💰 عميل جديد #${converted}: ${name.slice(0, 40)} (score ${score})`)
    } catch (e) {
      console.log(`   ⚠️ فشل تحويل بوست ${post.id.slice(0, 8)}: ${(e as Error).message.slice(0, 60)}`)
    }
  }
  console.log(`== تحويل تلقائي: ${converted} عميل من ${qualified.length} بوست مؤهل ==`)
  await (db as { $disconnect: () => Promise<void> }).$disconnect()
}

main().catch((e) => {
  console.error("ERR:", e instanceof Error ? e.message : e)
  process.exit(1)
})
