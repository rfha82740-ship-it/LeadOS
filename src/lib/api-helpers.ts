// LeadOS — API helpers
import { NextResponse } from "next/server"
import { getSessionUser, getWorkspaceForUser, type SessionUser } from "@/lib/auth"
import { db } from "@/lib/db"
import type { Workspace } from "@prisma/client"

export function json(data: unknown, status = 200) {
  // requestId للـtrace: بيتولد في middleware وبيبقى في رد كل API (Observability #14)
  return NextResponse.json(data as Record<string, unknown>, { status })
}

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status })
}

export interface AuthContext {
  user: SessionUser
  workspace: Workspace
}

/** Requires an authenticated user; returns user+workspace or a 401/403 response. */
export async function requireAuth(opts?: { roles?: string[] }): Promise<AuthContext | NextResponse> {
  const user = await getSessionUser()
  if (!user) return jsonError("غير مسجل الدخول", 401)
  const workspace = await getWorkspaceForUser(user.id)
  if (!workspace) return jsonError("لا توجد مساحة عمل مرتبطة بحسابك", 403)
  // بوابة صلاحيات (أمن API #15): الأفعال الحرجة (إيقاف النظام…) للـOWNER/ADMIN فقط
  if (opts?.roles?.length) {
    const membership = await db.workspaceMember.findFirst({
      where: { userId: user.id, workspaceId: workspace.id },
      select: { role: true },
    })
    if (!membership || !opts.roles.includes(membership.role)) {
      return jsonError("غير مصرح — هذا الإجراء يحتاج صلاحية OWNER/ADMIN", 403)
    }
  }
  return { user, workspace }
}

// Rate limiting خفيف في الذاكرة (أمن API #15): حماية المسارات المكتِبة من الانفجار
const rateBuckets = new Map<string, { count: number; resetAt: number }>()
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const b = rateBuckets.get(key)
  if (!b || b.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs })
    if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (v.resetAt < now) rateBuckets.delete(k)
    return true
  }
  if (b.count >= max) return false
  b.count++
  return true
}

export function isResponse(x: unknown): x is NextResponse {
  return x instanceof NextResponse
}

/** Parse a JSON body safely. */
export async function readBody<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}
