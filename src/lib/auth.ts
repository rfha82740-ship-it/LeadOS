// LeadOS — Auth: scrypt password hashing + HS256 JWT session cookie
// Zero-dependency (node:crypto) for maximum portability across dev/prod.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto"
import { cookies } from "next/headers"
import { db } from "@/lib/db"

const SECRET = process.env.AUTH_SECRET || "leados-dev-secret-change-in-production"
export const SESSION_COOKIE = "leados_session"
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

// ---------- Password hashing (scrypt) ----------
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `scrypt$${salt}$${hash}`
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false
  const parts = stored.split("$")
  if (parts.length !== 3 || parts[0] !== "scrypt") return false
  const [, salt, hash] = parts
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, "hex")
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

// ---------- JWT (HS256) ----------
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

export function signToken(payload: Record<string, unknown>, ttlSeconds = SESSION_TTL_SECONDS): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const now = Math.floor(Date.now() / 1000)
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }))
  const sig = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url")
  return `${header}.${body}.${sig}`
}

export function verifyToken(token: string): Record<string, unknown> | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const expected = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url")
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

// ---------- Session helpers ----------
export async function createSession(userId: string): Promise<void> {
  const token = signToken({ sub: userId })
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  })
}

export async function destroySession(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
}

export interface SessionUser {
  id: string
  email: string
  name: string | null
  role: string
}

export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const store = await cookies()
    const token = store.get(SESSION_COOKIE)?.value
    if (!token) return null
    const payload = verifyToken(token)
    if (!payload || typeof payload.sub !== "string") return null
    const user = await db.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true, isActive: true, passwordChangedAt: true },
    })
    if (!user || !user.isActive) return null
    // إبطال الجلسات الصادرة قبل آخر تغيير كلمة مرور (تدوير credential ⇒ كل الجلسات القديمة تموت فورًا)
    // هامش ثانية واحدة: iat بدقة ثانية وpasswordChangedAt بدقة ميلي — الجلسة الصادرة نفس اللحظة تبقى صالحة
    if (user.passwordChangedAt && typeof payload.iat === "number" && payload.iat * 1000 < user.passwordChangedAt.getTime() - 999) return null
    return { id: user.id, email: user.email, name: user.name ?? "", role: user.role }
  } catch {
    return null
  }
}

export async function getWorkspaceForUser(userId: string) {
  const membership = await db.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  })
  return membership?.workspace ?? null
}
