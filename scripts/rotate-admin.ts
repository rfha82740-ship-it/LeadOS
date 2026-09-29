// LeadOS — تدوير كلمة مرور Admin الإنتاجية (Final Hardening #1)
// كلمة قوية عشوائية crypto — تتحدث مباشرة في Neon — تطبع مرة واحدة فقط هنا (قناة التسليم الوحيدة)
// + تنسخها لملف .secrets/ (مستثنى من Git) للتحقق لاحقًا. ممنوع في Git/لوجز/workflows.
import { randomBytes, scryptSync, randomUUID } from "node:crypto"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { PrismaClient } from "@prisma/client"

// DATABASE_URL من .env.vercel-prod (بدون طباعة القيمة)
function prodDbUrl(): string {
  for (const line of readFileSync(".env.vercel-prod", "utf8").split("\n")) {
    const m = line.match(/^DATABASE_URL="?(.+)"?\s*$/)
    if (m && m[1].includes("neon.tech")) return m[1]
  }
  throw new Error("لا يوجد DATABASE_URL لـNeon في .env.vercel-prod")
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `scrypt$${salt}$${hash}`
}

const ALPHA = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*"
function strongPassword(): string {
  const bytes = randomBytes(24)
  let out = ""
  for (const b of bytes) out += ALPHA[b % ALPHA.length]
  return out
}

async function main() {
  const emailArg = (process.argv[2] ?? "").trim().toLowerCase()
  const db = new PrismaClient({ datasources: { db: { url: prodDbUrl() } } })
  const host = new URL(prodDbUrl()).host
  console.log("DB host:", host)
  await db.$queryRaw`SELECT 1`

  const owners = await db.user.findMany({
    where: { role: "OWNER", isActive: true },
    select: { id: true, email: true, name: true, createdAt: true },
  })
  if (!owners.length) throw new Error("لا يوجد OWNER نشط")
  console.log("OWNER accounts:", owners.map(o => o.email).join(", "))

  const target = emailArg
    ? owners.find(o => o.email === emailArg)
    : owners.find(o => o.email.includes("admin")) ?? owners[0]
  if (!target) throw new Error("المستخدم المطلوب غير موجود")

  const password = strongPassword()
  await db.user.update({ where: { id: target.id }, data: { passwordHash: hashPassword(password) } })

  // تسجيل في AuditLog — بدون أي قيمة سرية
  const ws = await db.workspaceMember.findFirst({ where: { userId: target.id }, select: { workspaceId: true } })
  await db.auditLog.create({
    data: {
      workspaceId: ws?.workspaceId ?? owners.length ? (await db.workspace.findFirst({ select: { id: true } }))!.id : (await db.workspace.findFirst({ select: { id: true } }))!.id,
      userId: target.id,
      action: "ADMIN_PASSWORD_ROTATED",
      entityType: "User",
      entityId: target.id,
      after: { rotatedAt: new Date().toISOString(), reason: "final-hardening: previous credential exposed in report", nonce: randomUUID() },
    },
  }).catch(() => undefined)

  // نسخة محلية في .secrets (مستثنى من Git) — للتسليم والتحقق فقط
  try {
    mkdirSync(".secrets", { recursive: true })
    writeFileSync(".secrets/admin-credential.txt", `USERNAME: ${target.email}\nPASSWORD: ${password}\nROTATED: ${new Date().toISOString()}\n`, { mode: 0o600 })
  } catch { /* غير حرِج */ }

  console.log("✅ PASSWORD ROTATED في Neon")
  console.log(`USERNAME: ${target.email}`)
  console.log(`PASSWORD: ${password}`)
  console.log("(تُسلَّم مرة واحدة في التقرير — لا Git، لا لوجز، لا workflows)")
  await db.$disconnect()
}

main().catch(e => { console.error("فشل:", e instanceof Error ? e.message.slice(0, 200) : e); process.exit(1) })
