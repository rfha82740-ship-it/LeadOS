// LeadOS — جردة «مافيش حاجة لوكل»: مقارنة عدد الصفوف بين SQLite المحلي (ساندبوكس التطوير) و Neon الإنتاج
// المخرج: أي جدول فيه بيانات موجودة محليًا ومش موجودة على Neon = بيانات محبوسة لوكل لازم تتنقل
import { Database } from "bun:sqlite"

const SKIP = new Set(["sqlite_sequence", "_prisma_migrations", "_cf_KV", "_cf_KV_values"])

function localCounts(): Map<string, number> {
  const sq = new Database("db/custom.db", { readonly: true })
  const out = new Map<string, number>()
  const tables = sq
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>
  for (const { name } of tables) {
    if (SKIP.has(name) || name.startsWith("_")) continue
    try {
      const row = sq.query(`SELECT COUNT(*) as c FROM "${name}"`).get() as { c: number }
      out.set(name, row.c)
    } catch {
      out.set(name, -1)
    }
  }
  sq.close()
  return out
}

async function neonCounts(): Promise<Map<string, number>> {
  // قراءة DATABASE_URL من .env.vercel-prod مباشرة (سطر لسطر — قد يكون بين علامات تنصيص)
  const line = await Bun.file(".env.vercel-prod")
    .text()
    .then((t) => t.split("\n").find((l) => l.startsWith("DATABASE_URL=")))
  if (!line) throw new Error("DATABASE_URL مش موجود في .env.vercel-prod")
  const url = line
    .slice("DATABASE_URL=".length)
    .trim()
    .replace(/^["']|["']$/g, "")
  const { PrismaClient } = await import("@prisma/client")
  const db = new PrismaClient({ datasources: { db: { url } } })
  const out = new Map<string, number>()
  const rows = (await db.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
  )) as Array<{ table_name: string }>
  for (const { table_name: name } of rows) {
    if (name.startsWith("_prisma") || name.startsWith("_")) continue
    try {
      const cnt = (await db.$queryRawUnsafe(
        `SELECT COUNT(*)::int as c FROM "${name}"`
      )) as Array<{ c: number }>
      out.set(name, cnt[0]?.c ?? 0)
    } catch (e) {
      out.set(name, -1)
    }
  }
  await db.$disconnect()
  return out
}

const local = localCounts()
const neon = await neonCounts()

console.log("=== LOCAL SQLITE (db/custom.db — ساندبوكس التطوير فقط) ===")
for (const [t, c] of [...local.entries()].sort()) console.log(`${t}: ${c}`)
console.log("")
console.log("=== NEON PRODUCTION ===")
for (const [t, c] of [...neon.entries()].sort()) console.log(`${t}: ${c}`)
console.log("")

// التشابك: جداول ليها بيانات محلي ومفيش/قليل على Neon
console.log("=== مقارنة (جدول: محلي → Neon) — الجداول اللي محتاجة نظرة ===")
let stuck = false
for (const [t, lc] of [...local.entries()].sort()) {
  if (lc <= 0) continue
  const nc = neon.get(t)
  if (nc === undefined) {
    console.log(`⚠ ${t}: محلي=${lc} | Neon=الجدول مش موجود`)
    stuck = true
  } else if (nc === 0) {
    console.log(`⚠ ${t}: محلي=${lc} | Neon=0 (فاضي إنتاجيًا)`)
    stuck = true
  }
}
if (!stuck) console.log("✔ مافيش أي جدول فيه بيانات محبوسة لوكل — كل حاجة على Neon")
export {}
