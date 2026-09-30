#!/usr/bin/env bun
/**
 * LeadOS — Final Production Audit (§33/§34)
 * كل بند بيتحقق من المصدر الفعلي: Vercel API / GitHub API / Neon (dbq) / production endpoints.
 * ممنوع طباعة أي قيم أسرار — الحالات فقط.
 */
import { readFileSync } from "node:fs"

type Verdict = "PASS" | "WARN" | "FAIL"
interface Row { check: string; verdict: Verdict; detail: string }

const ROOT = new URL("..", import.meta.url).pathname

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#") || !t.includes("=")) continue
      const i = t.indexOf("=")
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^"|"$/g, "")
    }
  } catch { /* ignore */ }
  return env
}

const prod = loadEnv(`${ROOT}.env.vercel-prod`)
const BASE = prod.LEADOS_BASE_URL || "https://leados-v2.vercel.app"
const REPO = "rfha82740-ship-it/LeadOS"
const rows: Row[] = []

function row(check: string, verdict: Verdict, detail: string) {
  rows.push({ check, verdict, detail })
  console.log(`${verdict.padEnd(4)} ${check} — ${detail}`)
}

async function gh(path: string, token: string) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20_000),
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

async function call(method: string, path: string, opts: { token?: string; apikey?: string; body?: unknown; timeout?: number } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Cookie: `leados_session=${opts.token}` } : {}),
      ...(opts.apikey ? { "x-api-key": opts.apikey } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout ?? 30_000),
  })
  const json = await r.json().catch(() => ({}))
  return { status: r.status, json }
}

function b64url(b: Uint8Array | string) {
  return Buffer.from(b as any).toString("base64url")
}
function mintAdmin(): string {
  const { createHmac } = require("node:crypto") as typeof import("node:crypto")
  const secret = prod.AUTH_SECRET
  const sub = "0017a7f9-eec0-40fa-98d2-bc681dd7eb38" // leados.admin OWNER
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const now = Math.floor(Date.now() / 1000)
  const p = b64url(JSON.stringify({ sub, iat: now, exp: now + 3600 }))
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")
  return `${h}.${p}.${sig}`
}

function dbq(sql: string): any {
  const p = Bun.spawnSync(["python3", `${ROOT}dbq.py`, "NEON_LEADOS_POOLED", sql], { timeout: 60_000 })
  const out = p.stdout.toString()
  try { return JSON.parse(out) } catch { return null }
}

async function main() {
  const ghToken = readFileSync(`${process.env.HOME}/.git-credentials`, "utf8").trim()
    .split("://")[1]!.split("@")[0]!.split(":")[1]!
  const vToken = readFileSync(`${process.env.HOME}/.vercel_token`, "utf8").trim()
  const admin = mintAdmin()
  const cronSecret = prod.CRON_SECRET || ""

  // ── 1) VERCEL ──────────────────────────────────────────────
  try {
    const r = await fetch(`https://api.vercel.com/v6/deployments?projectId=prj_t6eWDN0XUg5RyLJLFCXpHRmjwpbC&target=production&limit=1&teamId=team_Mj6Wa8s6k12NshbngshHQJqP`, {
      headers: { Authorization: `Bearer ${vToken}` }, signal: AbortSignal.timeout(20_000),
    })
    const d = await r.json()
    const dep = d.deployments?.[0]
    const ready = dep?.readyState === "READY"
    row("Vercel production deployment", ready ? "PASS" : "FAIL",
      `${dep?.readyState} @ ${(dep?.meta?.githubCommitSha || "?").slice(0, 7)} (${new Date(dep?.created).toISOString().slice(0, 16)})`)
  } catch (e) {
    row("Vercel production deployment", "FAIL", `API error: ${e}`)
  }

  // ── 2) GITHUB ──────────────────────────────────────────────
  try {
    const { json } = await gh(`/repos/${REPO}`, ghToken)
    const suspended = json.message === "Repository account was suspended"
    row("GitHub repository", !suspended && json.full_name === REPO ? "PASS" : "FAIL",
      `${json.full_name ?? json.message} private=${json.private ?? "?"}`)
    const { json: runs } = await gh(`/repos/${REPO}/actions/runs?per_page=20`, ghToken)
    const active = (runs.workflow_runs ?? []).filter((x: any) => ["in_progress", "queued", "waiting"].includes(x.status))
    const failRecent = (runs.workflow_runs ?? []).filter((x: any) => x.conclusion === "failure" && Date.now() - +new Date(x.created_at) < 3600_000)
    row("GitHub Actions activity", active.length > 0 ? "PASS" : (failRecent.length ? "WARN" : "WARN"),
      `نشطة الآن: ${active.length} (${[...new Set(active.map((x: any) => x.name))].join(", ") || "لا شيء"}) | فاشلة آخر ساعة: ${failRecent.length}`)
  } catch (e) {
    row("GitHub Actions activity", "FAIL", `API error: ${e}`)
  }

  // ── 3) NEON / DATABASE ─────────────────────────────────────
  const snap = dbq(`SELECT
    (SELECT count(*) FROM "Lead") leads,
    (SELECT count(*) FROM "Business") businesses,
    (SELECT count(*) FROM "ContentItem" WHERE "collectedAt" > now() - interval '24 hours') contents24h,
    (SELECT count(*) FROM "Job" WHERE status='QUEUED') queued,
    (SELECT count(*) FROM "Job" WHERE status='RUNNING') running,
    (SELECT count(*) FROM "Job" WHERE status='RUNNING' AND "lockedAt" < now() - interval '15 minutes') stale,
    (SELECT count(*) FROM "TaskGraph") graphs,
    (SELECT COALESCE((SELECT state FROM "SystemState" LIMIT 1),'NONE')::text) state`)
  if (snap && snap[0]) {
    const s = snap[0]
    row("Neon DB reachable", "PASS", `leads=${s.leads} businesses=${s.businesses}`)
    row("Hunting throughput (24h)", Number(s.contents24h) > 0 ? "PASS" : "WARN", `ContentItems آخر 24س = ${s.contents24h}`)
    row("Queue health", Number(s.stale) === 0 ? "PASS" : "FAIL",
      `queued=${s.queued} running=${s.running} stale=${s.stale}`)
    row("SystemState record", s.state === "RUNNING" ? "PASS" : (s.state === "DEGRADED" ? "WARN" : "FAIL"), `state=${s.state}`)
    row("DSI graphs", Number(s.graphs) > 0 ? "PASS" : "WARN", `TaskGraph rows=${s.graphs}`)
  } else {
    row("Neon DB reachable", "FAIL", "dbq failed")
  }

  // ── 4) AI LAYER (production self-check) ────────────────────
  try {
    const { status, json } = await call("GET", `/api/ai-check?secret=${encodeURIComponent(cronSecret)}`, { timeout: 60_000 })
    const ok = status === 200
    const dahl = JSON.stringify(json).includes('"dahl"') || JSON.stringify(json).toLowerCase().includes("dahl")
    row("AI layer (production ai-check)", ok ? "PASS" : "FAIL", `HTTP ${status} dahl=${dahl}`)
  } catch (e) {
    row("AI layer (production ai-check)", "FAIL", `${e}`)
  }

  // ── 5) INGEST / FARM PLAN (search+skills intelligence) ─────
  const ing = prod.INGEST_API_KEY || prod.LEADOS_API_KEY || ""
  try {
    const { status, json } = await call("GET", "/api/ingest/webhook", { apikey: ing })
    row("Ingest webhook key-verification", status === 200 ? "PASS" : "FAIL", `HTTP ${status}`)
  } catch { row("Ingest webhook key-verification", "FAIL", "error") }
  try {
    const { status, json } = await call("GET", "/api/farm/plan?platform=FACEBOOK", { apikey: ing })
    const plan = json?.planId
    row("Farm skill-intelligence plan", status === 200 && !!plan ? "PASS" : "FAIL",
      `HTTP ${status} planId=${plan ?? "-"} selectedBy=${json?.selectedBy ?? "-"}`)
  } catch (e) { row("Farm skill-intelligence plan", "FAIL", `${e}`) }

  // ── 6) SYSTEM STATE / STOP / CAPACITY ──────────────────────
  try {
    const { status, json } = await call("GET", "/api/system/stop", { token: admin })
    const live = json?.systemState
    row("STOP control (live state)", status === 200 ? "PASS" : "FAIL",
      `state=${live} stopFile=${json?.stopFile} stopControlReady=${json?.stopControlReady}`)
  } catch (e) { row("STOP control (live state)", "FAIL", `${e}`) }
  try {
    const { status, json } = await call("GET", "/api/system/capacity", { token: admin })
    row("Concurrency capacity (server view)", status === 200 ? "PASS" : "FAIL",
      `limit=${json?.limit} running=${json?.runningJobs} available=${json?.availableSlots}`)
  } catch (e) { row("Concurrency capacity (server view)", "FAIL", `${e}`) }

  // ── 7) DASHBOARD (session-gated) ───────────────────────────
  const pages = ["/", "/leads", "/queue", "/system", "/skills", "/groups", "/radar", "/settings"]
  let ok200 = 0
  for (const p of pages) {
    try { const r = await fetch(`${BASE}${p}`, { headers: { Cookie: `leados_session=${admin}` }, signal: AbortSignal.timeout(20_000) }); if (r.status === 200) ok200++ } catch { /* noop */ }
  }
  row("Dashboard screens reachable", ok200 === pages.length ? "PASS" : (ok200 > 5 ? "WARN" : "FAIL"), `${ok200}/${pages.length} = 200 (SPA: 25 views)`)

  // ── 8) ALERTS ──────────────────────────────────────────────
  try {
    const { status, json } = await call("GET", "/api/alerts", { token: admin })
    row("Alert engine API", status === 200 ? "PASS" : "FAIL", `HTTP ${status} alerts=${(json?.alerts ?? []).length}`)
  } catch (e) { row("Alert engine API", "FAIL", `${e}`) }

  // ── SUMMARY ────────────────────────────────────────────────
  const pass = rows.filter(r => r.verdict === "PASS").length
  const warn = rows.filter(r => r.verdict === "WARN").length
  const fail = rows.filter(r => r.verdict === "FAIL").length
  console.log(`\n${"=".repeat(60)}\nFINAL PRODUCTION AUDIT: ${pass} PASS | ${warn} WARN | ${fail} FAIL  (total ${rows.length})\n${"=".repeat(60)}`)
  if (fail > 0) process.exit(1)
}

main()
