import { db } from "@/lib/db"
import { json, jsonError, readBody, rateLimit } from "@/lib/api-helpers"
import { getSessionUser } from "@/lib/auth"
import { ingestDiscoveredItems } from "@/lib/queue"
import type { DiscoveredItem } from "@/lib/discovery"

/**
 * External ingestion webhook — the bridge between LeadOS and open-source workers
 * (Botasaurus / Camoufox / any HTTP client).
 *
 * Auth: `x-api-key` header OR `Authorization: Bearer <INGEST_API_KEY>` matching the
 * INGEST_API_KEY env var, OR an authenticated browser session (for in-app testing).
 *
 * Payload:
 * {
 *   "source":   "Botasaurus Worker",     // optional source name (default: Botasaurus Worker)
 *   "platform": "GOOGLE_MAPS",           // SourceType: FACEBOOK|LINKEDIN|X|REDDIT|INSTAGRAM|TIKTOK|YOUTUBE|GOOGLE_MAPS|GOOGLE_SEARCH|WEBSITE|NEWS|DIRECTORY|OTHER
 *   "items": [ { name, url, body?, phone?, website?, address?, city?, rating?,
 *                reviewCount?, placeId?, handle?, publishedAt?, externalId? } ]
 * }
 *
 * Everything downstream (classification → dedup → Business/Lead → scoring → hot-lead
 * research) reuses the exact same pipeline as internal discovery jobs.
 */

const VALID_SOURCE_TYPES = new Set([
  "FACEBOOK", "LINKEDIN", "X", "REDDIT", "INSTAGRAM", "TIKTOK", "YOUTUBE",
  "TELEGRAM", "GOOGLE_MAPS", "GOOGLE_SEARCH", "WEBSITE", "NEWS", "RSS", "DIRECTORY",
  "JOBS", "MARKETPLACE", "FREELANCE", "ADS_LIBRARY", "REVIEWS", "EVENTS", "QUORA", "DISCORD",
  "OTHER",
])
const SOCIAL_TYPES = new Set(["FACEBOOK", "INSTAGRAM", "X", "LINKEDIN", "REDDIT", "TIKTOK", "YOUTUBE", "TELEGRAM", "QUORA", "DISCORD"])
const MAX_ITEMS = 200

interface WorkerItem {
  externalId?: string
  name?: string
  url?: string
  body?: string
  phone?: string
  website?: string
  address?: string
  city?: string
  rating?: number
  reviewCount?: number
  placeId?: string
  handle?: string
  email?: string
  publishedAt?: string
  // منشأ الاستعلام (تكامل عقل المهارات ↔ المزرعة): كل عنصر يتحمل مصدر استعلامه
  query?: string
  querySource?: string
  planId?: string
  skillId?: string
  skillKind?: string
}

interface WorkerPayload {
  source?: string
  platform?: string
  items?: WorkerItem[]
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** Deterministic externalId so the same business sent twice dedupes at ContentItem level. */
function buildExternalId(platform: string, item: WorkerItem): string {
  if (item.externalId) return `${platform}:${item.externalId}`.slice(0, 180)
  const base = [item.placeId, item.phone, item.website, item.url, item.name]
    .map((x) => (x ?? "").toLowerCase().trim())
    .filter(Boolean)
    .join("|")
  // Simple deterministic hash (FNV-1a) — enough for dedup, no crypto dependency
  let h = 0x811c9dc5
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${platform}:${(h >>> 0).toString(36)}`
}

async function handle(req: Request) {
  // ---- Auth ----
  const key = process.env.INGEST_API_KEY
  const url = new URL(req.url)
  const provided =
    req.headers.get("x-api-key") ??
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice(7)
      : undefined) ??
    url.searchParams.get("key") ??
    undefined
  const authorized = (key && provided === key) || Boolean(await getSessionUser())
  if (!authorized) return jsonError("غير مصرح — مفتاح INGEST_API_KEY مطلوب", 401)
  // Rate limit (أمن API #15): أقصى 60 دفعة/دقيقة لكل مفتاح — 200 عنصر/دفعة كحد أقصى مُسبق
  if (!rateLimit(`ingest:${provided?.slice(-8) ?? "session"}`, 60, 60_000)) return jsonError("حصة الابتلاع مؤقتًا مليانة — جرب بعد دقيقة", 429)

  // ---- Parse ----
  const body = await readBody<WorkerPayload>(req)
  if (!body) return jsonError("جسم الطلب غير صالح", 400)
  const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : []
  if (!items.length) return jsonError("لا توجد عناصر في items", 400)

  const platformRaw = str(body.platform) ?? "OTHER"
  const platform = platformRaw.toUpperCase().replace(/\s+/g, "_")
  const sourceType = (VALID_SOURCE_TYPES.has(platform) ? platform : "OTHER") as never
  const sourceName = str(body.source) ?? "Botasaurus Worker"

  // ---- Default workspace (single-tenant deployment) ----
  const ws = await db.workspace.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } })
  if (!ws) return jsonError("لا يوجد workspace", 400)

  // ---- Find or create the Source for this worker ----
  let source = await db.source.findFirst({ where: { workspaceId: ws.id, name: sourceName } })
  if (!source) {
    source = await db.source.create({
      data: {
        workspaceId: ws.id,
        type: sourceType,
        name: sourceName,
        status: "ACTIVE",
        config: { worker: "external", platform, note: "أُنشئ تلقائيًا بواسطة webhook الاستقبال" },
      },
    })
  }

  // ---- Normalize worker items → DiscoveredItem (same shape internal discovery produces) ----
  const discovered: DiscoveredItem[] = []
  for (const it of items) {
    const name = str(it.name)
    if (!name) continue // a lead without a name is unusable
    const u = str(it.url)
    const handle = str(it.handle)
    const canonicalUrl =
      u ?? (handle ? `https://www.${platform.toLowerCase()}.com/${handle.replace(/^@/, "")}` : "")
    const desc = str(it.body) ?? ""
    const bits = [
      it.address ? `العنوان: ${it.address}` : null,
      it.rating !== undefined ? `التقييم: ${it.rating}` : null,
      it.reviewCount !== undefined ? `عدد المراجعات: ${it.reviewCount}` : null,
    ].filter(Boolean)
    const bodyText = [desc, ...bits].filter(Boolean).join(" — ")
    discovered.push({
      externalId: buildExternalId(platform, it),
      title: name,
      body: bodyText || `عميل محتمل من ${platform} — ${name}`,
      url: canonicalUrl,
      authorName: name,
      authorHandle: handle,
      publishedAt: it.publishedAt ? new Date(it.publishedAt) : undefined,
      contentType: platform === "GOOGLE_MAPS" ? "BUSINESS" : SOCIAL_TYPES.has(platform) ? "PAGE" : "WEBSITE_PAGE",
      language: /[\u0600-\u06FF]/.test(bodyText + name) ? "ar" : "en",
      rawData: {
        platform,
        phone: str(it.phone),
        website: str(it.website),
        address: str(it.address),
        city: str(it.city),
        rating: num(it.rating),
        reviewCount: num(it.reviewCount),
        placeId: str(it.placeId),
        email: str(it.email) ?? str((it as { extra_email?: unknown }).extra_email),
        worker: "external",
        // منشأ الاستعلام — قابل للتدقيق من اللوحة (43.10)
        querySource: str(it.querySource) ?? "static",
        planId: str(it.planId),
        skillId: str(it.skillId),
        skillKind: str(it.skillKind),
      },
      // يغذي حلقة التعلم تلقائيًا: recordSkillLead + recordLesson في الابتلاع
      viaQuery: str(it.query),
    })
  }
  if (!discovered.length) return jsonError("كل العناصر ناقصة الاسم — لا يمكن المعالجة", 400)

  // ---- Run the shared pipeline ----
  const result = await ingestDiscoveredItems(ws.id, source, null, discovered)
  await db.source.update({ where: { id: source.id }, data: { lastRunAt: new Date(), lastError: null } })

  return json({
    ok: true,
    source: source.name,
    platform,
    received: discovered.length,
    leadsCreated: result.created,
    duplicates: result.duplicates,
    at: new Date().toISOString(),
  })
}

export async function POST(req: Request) {
  return handle(req)
}

// GET returns a tiny status doc so you can verify the key works from a browser/curl
export async function GET(req: Request) {
  const key = process.env.INGEST_API_KEY
  const provided =
    req.headers.get("x-api-key") ?? new URL(req.url).searchParams.get("key") ?? undefined
  const authorized = (key && provided === key) || Boolean(await getSessionUser())
  if (!authorized) return jsonError("غير مصرح", 401)
  return json({
    ok: true,
    endpoint: "POST /api/ingest/webhook",
    expects: { source: "string?", platform: "SourceType", items: "[{ name, url?, body?, phone?, website?, ... }]" },
    maxItems: MAX_ITEMS,
  })
}
