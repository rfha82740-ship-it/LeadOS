// LeadOS — تحقق نهائي: enum JobType على Neon فيه القيم الجديدة؟ وجدول LeadExport موجود؟
const line = await Bun.file(".env.vercel-prod")
  .text()
  .then((t) => t.split("\n").find((l) => l.startsWith("DATABASE_URL=")))
const url = line!.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "")
const { PrismaClient } = await import("@prisma/client")
const db = new PrismaClient({ datasources: { db: { url } } })

const enumVals = (await db.$queryRawUnsafe(
  `SELECT v::text AS val FROM unnest(enum_range(NULL::"JobType")) AS v WHERE v::text IN ('CLAWHUB_HARVEST','FB_COMMENT')`
)) as Array<{ val: string }>
console.log("JobType enum القيم الجديدة:", enumVals.map((r) => r.val).join(", ") || "❌ مش موجودين!")

const t = (await db.$queryRawUnsafe(
  `SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema='public' AND table_name='LeadExport'`
)) as Array<{ c: number }>
console.log("جدول LeadExport على Neon:", t[0]?.c ? "✔ موجود" : "❌ مش موجود")

await db.$disconnect()
export {}
