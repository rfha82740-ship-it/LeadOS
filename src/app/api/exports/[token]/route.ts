// LeadOS — تحميل تصدير CSV من الاستضافة: /api/exports/[token]
// التوكن unguessable (cuid) — بيتولد لحظة التصدير وبيتخدم كصلاحية تحميل.
// الملف نفسه معاه BOM (UTF-8) عشان Excel يفتح العربي صح.
import { db } from "@/lib/db"

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  if (!token) return new Response("Bad request", { status: 400 })

  const exp = await db.leadExport.findUnique({ where: { token } })
  if (!exp) return new Response("غير موجود أو انتهت صلاحية الرابط", { status: 404 })

  return new Response(exp.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exp.filename}"`,
      "Cache-Control": "private, max-age=60",
    },
  })
}
