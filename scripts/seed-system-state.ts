// LeadOS — تهيئة SystemState + إبطال الجلسات القديمة بعد تدوير كلمة المرور (Final Hardening #1/#5)
import { PrismaClient } from "@prisma/client"

async function main() {
  const db = new PrismaClient()
  const r1 = await db.user.updateMany({ where: { role: "OWNER" }, data: { passwordChangedAt: new Date() } })
  console.log("passwordChangedAt set on", r1.count, "OWNERs")
  const ss = await db.systemState.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton", state: "RUNNING" } })
  console.log("SystemState singleton:", ss.state)
  await db.$disconnect()
}
main().catch(e => { console.error("فشل:", e instanceof Error ? e.message.slice(0, 150) : e); process.exit(1) })
