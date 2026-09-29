// LeadOS — إنشاء مستخدم Admin للإنتاج (طلب #31/#33)
// كلمة مرور عشوائية قوية — تُطبع مرة واحدة هنا فقط (لا Git، لا لوجز النظام)
// الاستخدام: DATABASE_URL=<neon> bunx tsx scripts/prod-create-admin.ts <email> [name]
import { randomBytes, scryptSync } from "node:crypto"
import { PrismaClient } from "@prisma/client"

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `scrypt$${salt}$${hash}`
}

const ALPHA = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*"
function strongPassword(): string {
  const bytes = randomBytes(20)
  let out = ""
  for (const b of bytes) out += ALPHA[b % ALPHA.length]
  return out
}

async function main() {
  const email = (process.argv[2] ?? "").trim().toLowerCase()
  const name = process.argv[3] ?? "Owner"
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("الاستخدام: bunx tsx scripts/prod-create-admin.ts <email> [name]")
    process.exit(2)
  }
  const db = new PrismaClient()
  const existing = await db.user.findUnique({ where: { email } })
  const password = strongPassword()
  if (existing) {
    console.log("⚠️ المستخدم موجود بالفعل — لن تتغير كلمة المرور (الأمان: لا إعادة تعيين صامتة)")
    console.log(`USERNAME: ${email}`)
    await db.$disconnect()
    return
  }
  const user = await db.user.create({
    data: { email, name, passwordHash: hashPassword(password), role: "OWNER", isActive: true },
  })
  // ربطه بـالworkspace الحالي كـOWNER لو مفيش عضوية
  const ws = await db.workspace.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } })
  if (ws) {
    const member = await db.workspaceMember.findFirst({ where: { userId: user.id, workspaceId: ws.id } })
    if (!member) await db.workspaceMember.create({ data: { userId: user.id, workspaceId: ws.id, role: "OWNER" } })
  }
  console.log("✅ Admin اتبنى على الإنتاج")
  console.log(`USERNAME: ${email}`)
  console.log(`PASSWORD: ${password}`)
  console.log("(دي النسخة الوحيدة — احفظها في مدير كلمات مرور)")
  await db.$disconnect()
}

main().catch((e) => { console.error("فشل:", e instanceof Error ? e.message.slice(0, 200) : e); process.exit(1) })
