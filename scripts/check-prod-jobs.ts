// LeadOS — فحص صحة الجوبات على Neon الإنتاج (حصاد ClawHub/GitSkills + النبضة)
const line = await Bun.file(".env.vercel-prod")
  .text()
  .then((t) => t.split("\n").find((l) => l.startsWith("DATABASE_URL=")))
if (!line) throw new Error("DATABASE_URL مش موجود")
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "")
const { PrismaClient } = await import("@prisma/client")
const db = new PrismaClient({ datasources: { db: { url } } })

const jobs = (await db.$queryRawUnsafe(
  `SELECT id, type, status, "createdAt", "updatedAt", COALESCE("errorMessage",'') as lastError
   FROM "Job"
   WHERE type::text ILIKE '%CLAWHUB%' OR type::text ILIKE '%GITSKILL%' OR type::text ILIKE '%HARVEST%' OR type::text ILIKE '%TICK%'
   ORDER BY "createdAt" DESC LIMIT 12`
)) as Array<{ id: string; type: string; status: string; createdAt: Date; updatedAt: Date; lastError: string }>

console.log("=== آخر جوبات الحصاد/النبضة على Neon ===")
for (const j of jobs) {
  const err = j.lastError ? ` | خطأ: ${j.lastError.slice(0, 90)}` : ""
  console.log(
    `${j.createdAt.toISOString().slice(0, 16)} | ${j.type} | ${j.status}${err}`
  )
}

// آخر نشاط عام على النظام (أي جوب)
const recent = (await db.$queryRawUnsafe(
  `SELECT type, status, "createdAt" FROM "Job" ORDER BY "createdAt" DESC LIMIT 8`
)) as Array<{ type: string; status: string; createdAt: Date }>
console.log("")
console.log("=== آخر 8 جوبات أي نوع ===")
for (const j of recent)
  console.log(`${j.createdAt.toISOString().slice(0, 16)} | ${j.type} | ${j.status}`)

// آخر نشاط ليودز (دليل الحياة)
const lastLead = (await db.$queryRawUnsafe(
  `SELECT MAX("createdAt") as last FROM "Lead"`
)) as Array<{ last: Date | null }>
console.log("")
console.log(`آخر ليد اتولد على Neon: ${lastLead[0]?.last?.toISOString() ?? "لا يوجد"}`)

await db.$disconnect()
export {}
