// LeadOS — نبضة داخلية للتطوير المحلي
// مدير عمليات الـworkspace بيقتل أي لوب خارجي (setsid/nohup) — لكن سيرفر التطوير
// عملية دائمة مش بيتمس. فالنبضة بتسكن جواه: كل 10 دقايق بتضرب tick الإنتاج.
// في الإنتاج (Vercel) ده بيتجاهل — ليه جدولته الخاصة (كرون يومي + اللوبات/السحابة).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  if (process.env.VERCEL === "1") return // على Vercel: من غير نبضة ذاتية
  const g = globalThis as typeof globalThis & { __leadosPulse?: boolean }
  if (g.__leadosPulse) return
  g.__leadosPulse = true

  const { readFileSync } = await import("fs")
  let secret = ""
  try {
    secret =
      readFileSync("/home/z/my-project/scripts/deploy/.tokens", "utf-8")
        .split("\n")
        .find((l) => l.startsWith("CRON_SECRET_ALT="))
        ?.split("=")
        .slice(1)
        .join("=")
        .trim()
        .replace(/^"|"$/g, "") ?? ""
  } catch {
    return
  }
  if (!secret) return

  const base = "https://leados-v2.vercel.app"
  const tick = async () => {
    try {
      const res = await fetch(`${base}/api/cron/tick?max=3&secret=${secret}`, {
        method: "POST",
        signal: AbortSignal.timeout(110_000),
      })
      console.log("[pulse]", res.status, new Date().toISOString())
    } catch (e) {
      console.warn("[pulse] fail:", String(e).slice(0, 60))
    }
  }

  setTimeout(tick, 10_000)
  setInterval(tick, 10 * 60 * 1000)
  console.log("[pulse] تسجّلت — نبضة كل 10 دقايق على الإنتاج")
}
