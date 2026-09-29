"use client";
// LeadOS — shared UI helpers: api hooks, badges, formatting
import { useCallback, useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import {
  LEAD_STATUS_LABELS, TEMPERATURE_LABELS, INTENT_LABELS,
  SOURCE_TYPE_LABELS, LEAD_SOURCE_TYPE_LABELS, CONFIDENCE_LABELS,
} from "@/lib/constants"

// ---------- API ----------
export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function apiSend<T>(url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function useApi<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!url) return
    let cancelled = false
    setLoading(true)
    apiGet<T>(url)
      .then((d) => { if (!cancelled) { setData(d); setError(null) } })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, ...deps])

  return { data, loading, error, refresh }
}

// ---------- Formatting ----------
export function timeAgo(date: string | Date | null | undefined): string {
  if (!date) return "—"
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "الآن"
  if (mins < 60) return `منذ ${mins} دقيقة`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `منذ ${hrs} ساعة`
  const dys = Math.floor(hrs / 24)
  if (dys < 30) return `منذ ${dys} يوم`
  return new Date(date).toLocaleDateString("ar-EG")
}

export function fmtNum(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("ar-EG")
}

// ---------- Badges ----------
export function scoreColor(score: number): string {
  if (score >= 90) return "text-rose-400 bg-rose-500/10 border-rose-500/30"
  if (score >= 75) return "text-amber-400 bg-amber-500/10 border-amber-500/30"
  if (score >= 50) return "text-sky-400 bg-sky-500/10 border-sky-500/30"
  return "text-slate-400 bg-slate-500/10 border-slate-500/30"
}

export function tempColor(temp: string): string {
  switch (temp) {
    case "HOT": return "bg-rose-500/15 text-rose-300 border-rose-500/40"
    case "WARM": return "bg-amber-500/15 text-amber-300 border-amber-500/40"
    case "COLD": return "bg-sky-500/10 text-sky-300 border-sky-500/30"
    default: return "bg-slate-500/10 text-slate-400 border-slate-500/30"
  }
}

export function ScoreBadge({ score, className }: { score: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold", scoreColor(score), className)}>
      {score}
    </span>
  )
}

export function TempBadge({ temp }: { temp: string }) {
  const fire = temp === "HOT" ? " 🔥" : ""
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold", tempColor(temp))}>
      {TEMPERATURE_LABELS[temp] ?? temp}{fire}
    </span>
  )
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-xs font-medium text-secondary-foreground">
      {LEAD_STATUS_LABELS[status] ?? status}
    </span>
  )
}

export function IntentBadge({ intent }: { intent: string }) {
  const color =
    intent === "VERY_HIGH" ? "text-rose-300" :
    intent === "HIGH" ? "text-amber-300" :
    intent === "MEDIUM" ? "text-sky-300" : "text-slate-400"
  return <span className={cn("text-xs font-semibold", color)}>{INTENT_LABELS[intent] ?? intent}</span>
}

export function SourceBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {SOURCE_TYPE_LABELS[type] ?? LEAD_SOURCE_TYPE_LABELS[type] ?? type}
    </span>
  )
}

export function ConfidenceLabel({ conf }: { conf: string }) {
  return <span className="text-xs text-muted-foreground">{CONFIDENCE_LABELS[conf] ?? conf}</span>
}

// ---------- Score ring ----------
export function ScoreRing({ score, size = 76 }: { score: number; size?: number }) {
  const stroke = 7
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pct = Math.min(100, Math.max(0, score))
  const color = score >= 90 ? "#fb7185" : score >= 75 ? "#f59e0b" : score >= 50 ? "#38bdf8" : "#64748b"
  return (
    <svg width={size} height={size} className="shrink-0" role="img" aria-label={`Score ${score}`}>
      <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="stroke-secondary" fill="none" />
      <circle
        cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} stroke={color} fill="none"
        strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
      <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" fill={color} fontSize={size * 0.28} fontWeight="800">
        {score}
      </text>
    </svg>
  )
}

// ---------- Empty / loading ----------
export function EmptyState({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      {icon && <div className="text-muted-foreground/60">{icon}</div>}
      <p className="text-sm font-semibold text-muted-foreground">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted-foreground/70">{hint}</p>}
    </div>
  )
}

export function LoadingBlock({ label = "جارٍ التحميل..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-muted-foreground">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

// ---------- View types ----------
export type ViewKey =
  | "overview" | "groups" | "feed" | "leads" | "pipeline" | "research"
  | "sources" | "rules" | "sequences" | "chat" | "agent" | "entity" | "zizo" | "analytics" | "tasks" | "settings"
  | "health" | "ops" | "graph" | "skills" | "queue" | "logs" | "radar"

// ---------- Session user ----------
export interface Me {
  user: { id: string; email: string; name: string; role: string }
  workspace: { id: string; name: string; slug: string }
  memberCount: number
  ai: { nvidia: boolean; hasKey: boolean; models: { fast: string; main: string; reason: string }; note: string }
}
