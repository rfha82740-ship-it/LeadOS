// LeadOS — Observability middleware (Final Hardening #14): معرّف تتبع لكل طلب
// x-request-id: بيحترم الموجود (من الـload balancer) أو يولّد واحد — يظهر في كل الردود + سجلات الخادم.
// بدون تسجيل أي أسرار أو بيانات حساسة. (Web Crypto — Edge runtime compatible)
import { NextResponse, type NextRequest } from "next/server"

export function middleware(req: NextRequest) {
  const requestId = req.headers.get("x-request-id")?.slice(0, 64) || crypto.randomUUID()
  const res = NextResponse.next()
  res.headers.set("x-request-id", requestId)
  return res
}

export const config = {
  matcher: ["/api/:path*"],
}
