import { db } from "@/lib/db"
import { createSession, verifyPassword } from "@/lib/auth"
import { json, jsonError, readBody } from "@/lib/api-helpers"

// ─── حماية من التخمين (brute force): 5 محاولات غلط / دقيقة / IP ثم تهدئة 5 دقايق ───
// ذاكرة داخلية كافية للنشر الفردي — لو اتوزع على عقدة متعددة يتحول لـRedis
const LOGIN_WINDOW_MS = 60_000
const LOGIN_MAX_FAILS = 5
const LOGIN_COOLDOWN_MS = 5 * 60_000
const loginFails = new Map<string, { count: number; windowStart: number; blockedUntil: number }>()

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")
  return (fwd ? fwd.split(",")[0].trim() : null) || req.headers.get("x-real-ip") || "local"
}

function loginThrottled(req: Request): boolean {
  const key = clientIp(req)
  const rec = loginFails.get(key)
  if (!rec) return false
  const now = Date.now()
  if (rec.blockedUntil > now) return true
  return false
}

function noteLoginFail(req: Request): void {
  const key = clientIp(req)
  const now = Date.now()
  const rec = loginFails.get(key)
  if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) {
    loginFails.set(key, { count: 1, windowStart: now, blockedUntil: 0 })
    return
  }
  rec.count += 1
  if (rec.count >= LOGIN_MAX_FAILS) {
    rec.blockedUntil = now + LOGIN_COOLDOWN_MS
    rec.count = 0
    rec.windowStart = now
  }
}

function noteLoginSuccess(req: Request): void {
  loginFails.delete(clientIp(req))
}

// تنظيف دوري للذاكرة (يمنع النمو اللانهائي)
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of loginFails) {
    if (now - v.windowStart > LOGIN_WINDOW_MS && v.blockedUntil < now) loginFails.delete(k)
  }
}, 10 * 60_000).unref?.()

export async function POST(req: Request) {
  if (loginThrottled(req)) {
    return jsonError("محاولات كتير غلط — استنى 5 دقايق وجرب تاني", 429)
  }
  const body = await readBody<{ email?: string; password?: string }>(req)
  if (!body?.email || !body?.password) return jsonError("البريد وكلمة المرور مطلوبان")
  const email = body.email.trim().toLowerCase()
  const user = await db.user.findUnique({ where: { email } })
  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    noteLoginFail(req)
    return jsonError("بيانات الدخول غير صحيحة", 401)
  }
  if (!user.isActive) return jsonError("الحساب موقوف", 403)
  noteLoginSuccess(req)
  // الدخول الجديد يبطل كل الجلسات الأقدم منه (حماية من جلسة مسروقة قديمة)
  await db.user.update({ where: { id: user.id }, data: { passwordChangedAt: new Date() } }).catch(() => undefined)
  await createSession(user.id)
  return json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
}
