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
  await (db as { $disconnect: () => Promise<void> }).$disconnect()
}

main().catch((e) => {
  console.error("ERR:", e instanceof Error ? e.message : e)
  process.exit(1)
})
