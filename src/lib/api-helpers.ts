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

/** Requires an authenticated user; returns user+workspace or a 401 response. */
export async function requireAuth(): Promise<AuthContext | NextResponse> {
  const user = await getSessionUser()
  if (!user) return jsonError("غير مسجل الدخول", 401)
  const workspace = await getWorkspaceForUser(user.id)
  if (!workspace) return jsonError("لا توجد مساحة عمل مرتبطة بحسابك", 403)
  return { user, workspace }
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
