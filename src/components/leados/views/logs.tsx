"use client";
// LeadOS — شاشة السجلات والتدقيق: audit | ai | graph | retrieval | outcome | search | radar
import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { apiGet } from "../shared"

const TYPES = [
  { key: "audit", label: "تدقيق النظام" },
  { key: "graph", label: "أحداث الخرايط" },
  { key: "retrieval", label: "استرجاع المهارات" },
  { key: "outcome", label: "نتايج المهارات" },
  { key: "ai", label: "نداءات AI" },
  { key: "search", label: "جوبات البحث" },
  { key: "radar", label: "الرادار" },
] as const

interface GenericRow extends Record<string, unknown> { id: string; at?: string; createdAt?: string }

export function LogsView() {
  const [type, setType] = useState<string>("audit")
  const [q, setQ] = useState("")
  const [rows, setRows] = useState<GenericRow[]>([])

  useEffect(() => {
    apiGet<{ rows: GenericRow[] }>(`/api/logs?type=${type}${q ? `&q=${encodeURIComponent(q)}` : ""}&take=60`)
      .then((d) => setRows(d.rows ?? []))
      .catch(() => setRows([]))
  }, [type, q])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {TYPES.map((t) => (
          <button key={t.key} onClick={() => setType(t.key)} className={`rounded-full px-3 py-1 text-[11px] ${type === t.key ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
            {t.label}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="بحث في السجل…"
          className="ms-auto w-48 rounded-lg border border-input bg-card px-3 py-1 text-xs"
        />
      </div>

      <Card><CardContent className="max-h-[72vh] space-y-1 overflow-y-auto p-3">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border border-border/50 p-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              {"action" in r && <Badge variant="outline" className="text-[9px]">{String(r.action)}</Badge>}
              {"type" in r && type !== "search" && <Badge variant="outline" className="text-[9px]">{String(r.type)}</Badge>}
              {"provider" in r && <span className="text-[10px] font-bold">{String(r.provider)}{r.model ? ` · ${String(r.model)}` : ""}</span>}
              {"status" in r && <Badge className={String(r.status) === "SUCCESS" || r.success === true ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}>{String(r.status ?? (r.success === true ? "SUCCESS" : "FAILED"))}</Badge>}
              <span className="ms-auto text-[9px] text-muted-foreground">{r.at || r.createdAt ? new Date(String(r.at ?? r.createdAt)).toLocaleString("ar-EG") : ""}</span>
            </div>
            {"message" in r && <p className="mt-0.5 line-clamp-2 text-[11px]">{String(r.message)}</p>}
            {"reason" in r && Boolean(r.reason) && <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">{String(r.reason)}</p>}
            {"objective" in r && <p className="mt-0.5 line-clamp-1 text-[11px]">{String(r.objective)}</p>}
            {"query" in r && <p className="mt-0.5 text-[10px]">{String(r.query)}</p>}
            {"resultCount" in r && <p className="text-[10px] text-muted-foreground">نتايج: {String(r.resultCount)}</p>}
            {"errorMessage" in r && Boolean(r.errorMessage) && <p className="text-[10px] text-rose-400">{String(r.errorMessage)}</p>}
            {"content" in r && <p className="line-clamp-1 text-[10px] text-muted-foreground">{String(r.content)}</p>}
            {"group" in r && typeof r.group === "string" && <p className="text-[10px] text-muted-foreground">جروب: {r.group}</p>}
            {"entityType" in r && <p className="text-[10px] text-muted-foreground">{String(r.entityType)}{r.entityId ? ` · ${String(r.entityId).slice(0, 14)}` : ""}</p>}
            {"latencyMs" in r && r.latencyMs != null && <span className="text-[9px] text-muted-foreground">{String(r.latencyMs)}ms</span>}
          </div>
        ))}
        {!rows.length && <p className="p-4 text-center text-xs text-muted-foreground">مفيش سجلات بالفلتر ده</p>}
      </CardContent></Card>
    </div>
  )
}
