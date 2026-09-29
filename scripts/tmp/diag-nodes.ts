// LeadOS — تشخيص test-dsi #8: عدد العقد الحقيقي أثناء/بعد التشغيل
import { PrismaClient } from "@prisma/client"
import { runAgentGraph, inspectThinkingGraph } from "@/lib/thinking/engine"

async function main() {
  const db = new PrismaClient()
  const ws = await db.workspace.findFirst({ where: { isActive: true } })
  if (!ws) throw new Error("لا ورشة")
  const run = await runAgentGraph(ws.id, "ابحث عن مطاعم تحتاج نظام طلبات أونلاين في مصر الجديدة", { trigger: "API", budgetMs: 30_000 })
  console.log("graphId:", run.graphId.slice(0, 8), "| builtBy:", run.builtBy, "| status:", run.status)
  console.log("steps:", run.steps.map(s => `${s.nodeId}:${s.type}:${s.outcome}`).join(" → "))
  const insp = await inspectThinkingGraph(run.graphId)
  console.log("insp progress:", JSON.stringify(insp?.awareness.progress))
  const nodes = await db.taskGraphNode.findMany({ where: { graphId: run.graphId } })
  console.log("DB nodes:", nodes.length, "—", nodes.map(n => `${n.nodeId}:${n.status}`).join(" "))
  await db.$disconnect()
}
main().catch(e => { console.error("فشل:", e instanceof Error ? e.message.slice(0, 200) : e); process.exit(1) })
