// LeadOS — محرك خريطة التفكير (ThinkingGraphEngine — مواصفة 43.5 / 43.14 / 43.16 / 43.17 / 43.26)
// Master Control Flow: OBSERVE → UNDERSTAND → BUILD GRAPH → SELECT NODE →
// DETERMINE CAPABILITY → CHECK CORE/WORKSPACE SKILLS → SEARCH GITSKILLS IF NEEDED →
// RANK → TRUST GATE → ACTIVATE MINIMUM SET → POLICY GATE → EXECUTE → VERIFY →
// STORE EVIDENCE → STORE SKILL OUTCOME → UPDATE GRAPH → REPLAN → NEXT NODE.
//
// قرار معماري (43.15 — تقييم context4ai/agent-graph): المشروع حقيقي ونشط (MIT) لكن
// عمره شهور وبنفس العقود اللي بننفذها هنا أصلاً (Facts→Route→Evidence→Recovery) —
// فاعتمدنا العقد نفسه محليًا بدل اعتماد خارجي متغير على نظام إنتاج يعيش 24/7.
// Agent Graph لا يصبح مصدر سلطة — السلطة للسياسة الحتمية والـAI صاحب القرار فقط.
import { db } from "@/lib/db"
import { DSI_BUDGET } from "@/lib/skills/dsi/budget"
import { retrieveSkillsForNode, type SelectedSkillRef } from "@/lib/skills/dsi/retriever"
import { executeNodeWithSkills, nodeNeedsSkills, type NodeCtx } from "./executors"
import { buildThinkingGraph } from "./builder"
import type { GraphAwareness, GraphFacts } from "./types"

// إعادة تصدير واجهة المحرك الكاملة (للأدوات والأيجنت)
export { buildThinkingGraph } from "./builder"

type Json = unknown // أي JSON حرة داخل حقول Json في البريسما

// ═══ اختيار الـroute: أول عقدة قانونية (اعتماداتها محسومة: DONE أو SKIPPED أو FAILED) بالأولوية ═══
// الفاشل = مسار محسوم — عقد الاسترداد البديلة تقدر تجري (43.14: فشل مسار ≠ موت الخريطة)
async function selectRoute(graphId: string) {
  const nodes = await db.taskGraphNode.findMany({ where: { graphId }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] })
  const settled = new Set(nodes.filter((n) => n.status === "DONE" || n.status === "SKIPPED" || n.status === "FAILED").map((n) => n.nodeId))
  const ready = nodes.filter(
    (n) => n.status === "PENDING" && (n.dependencies as string[] | null ?? []).every((d) => settled.has(d)),
  )
  return { ready, nodes }
}

async function addEvent(graphId: string, nodeId: string | null, type: string, message: string, payload?: Json) {
  await db.taskGraphEvent.create({
    data: { graphId, nodeId, type, message: message.slice(0, 500), payload: (payload ?? undefined) as never },
  }).catch(() => undefined)
}

async function mergeFacts(graphId: string, patch: GraphFacts): Promise<GraphFacts> {
  const g = await db.taskGraph.findUnique({ where: { id: graphId }, select: { facts: true } })
  const facts = { ...((g?.facts ?? {}) as GraphFacts), ...patch }
  await db.taskGraph.update({ where: { id: graphId }, data: { facts: facts as never } }).catch(() => undefined)
  return facts
}

/** تنفيذ عقدة واحدة كاملة: استرجاع مهارات → تفعيل → تنفيذ → تحقق → أدلة */
export async function executeNodeStep(graphId: string, platformsHint?: string[]): Promise<{ nodeId: string; outcome: string; note: string } | null> {
  const graph = await db.taskGraph.findUnique({ where: { id: graphId } })
  if (!graph || graph.status !== "ACTIVE") return null
  const { ready } = await selectRoute(graphId)
  const node = ready[0]
  if (!node) return null

  const t0 = Date.now()
  // ═══ فرض maxAttemptsPerNode فعليًا (43.19): عقدة استنفدت محاولاتها = فشل نهائي ═══
  // (بدون الفرض ده: العقدة العالقة ترجع PENDING من الاستئناف وتحاول للأبد)
  if (node.attempts >= DSI_BUDGET.maxAttemptsPerNode) {
    await db.taskGraphNode.update({
      where: { id: node.id },
      data: { status: "FAILED", outcome: "FAILURE", failureReason: `استنفد المحاولات (${node.attempts}/${DSI_BUDGET.maxAttemptsPerNode}) — عقدة محسومة` },
    }).catch(() => undefined)
    await addEvent(graphId, node.nodeId, "REPLAN", `عقدة ${node.type} استنفدت محاولاتها (${node.attempts}) — محسومة فشل نهائي`)
    return { nodeId: node.nodeId, outcome: "FAILURE", note: "استنفد المحاولات" }
  }
  await db.taskGraphNode.update({ where: { id: node.id }, data: { status: "RUNNING", attempts: { increment: 1 } } })
  const facts = (graph.facts ?? {}) as GraphFacts
  let skills: SelectedSkillRef[] = []

  // ═══ RETRIEVE → RANK → TRUST GATE → ACTIVATE (لكل عقدة — مش مرة للمهمة، 43.6) ═══
  if (nodeNeedsSkills(node.type)) {
    try {
      // فرض skillRetrievalBudgetMs فعليًا: الاسترجاع اللي يتجاوز ميزانيته بيتقطع — العقدة تشتغل بالأساسي
      const r = await Promise.race([
        retrieveSkillsForNode({
          workspaceId: graph.workspaceId,
          objective: node.objective,
          nodeType: node.type,
          graphId,
          nodeId: node.nodeId,
          taskId: graph.sourceRunId ?? undefined,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), DSI_BUDGET.skillRetrievalBudgetMs)),
      ])
      skills = r?.selected ?? []
      if (r?.budgetExhausted) {
        await addEvent(graphId, node.nodeId, "BUDGET", `استرجاع متوقف: ${r.budgetExhausted} — العقدة تشتغل بالقدرات الأساسية`)
      }
      if (skills.length) {
        await addEvent(graphId, node.nodeId, "SKILL_SELECTED",
          `تفعيل ${skills.length} مهارة للعقدة: ${skills.map((s) => `[${s.kind}] ${s.name}`).join("، ")}`,
          { selected: skills, parsed: r?.parsed, semanticUsed: r?.semanticUsed ?? false, candidatesChecked: r?.candidatesChecked ?? 0 })
      }
    } catch { /* استرجاع فشل → العقدة تشتغل بالقدرات الأساسية (43.28 #21) */ }
  }

  // ═══ EXECUTE (بوابة السياسة داخل المنفذين — STRICT/HUMAN_APPROVAL ممنوع الإرسال المباشر) ═══
  const ctx: NodeCtx = {
    wsId: graph.workspaceId,
    graphId,
    graphCreatedAt: graph.createdAt,
    goal: graph.goal,
    nodeId: node.nodeId,
    objective: node.objective,
    type: node.type as never,
    facts,
    skills,
    platformsHint,
  }
  let result
  try {
    result = await executeNodeWithSkills(ctx)
  } catch (err) {
    result = { outcome: "FAILURE", note: `انفجار في المنفذ: ${err instanceof Error ? err.message.slice(0, 120) : "خطأ"}`, durationMs: Date.now() - t0 }
  }

  // ═══ VERIFY + STORE OUTCOME (التحقق بالمعايير — 43.21) ═══
  const okOutcomes = new Set(["SUCCESS", "PARTIAL", "SKIPPED"])
  const nodeStatus = okOutcomes.has(result.outcome) ? "DONE" : "FAILED"
  await db.taskGraphNode.update({
    where: { id: node.id },
    data: {
      status: nodeStatus,
      outcome: result.outcome,
      outcomeData: { note: result.note, ...(result.data ?? {}) } as never,
      failureReason: nodeStatus === "FAILED" ? result.note.slice(0, 300) : null,
    },
  }).catch(() => undefined)
  await addEvent(graphId, node.nodeId, "EVIDENCE", `${node.type}: ${result.note}`, { outcome: result.outcome, data: result.data ?? null })

  let mergedFacts = facts
  if (result.factsPatch) mergedFacts = await mergeFacts(graphId, result.factsPatch)

  // ═══ REPLAN (43.14) — الخريطة ليست ثابتة ═══
  await replan(graphId, node.nodeId, node.type, result.outcome, mergedFacts)

  // اختصار الذاكرة: OBSERVE لقى ذاكرة قابلة للاستخدام → فرع الصيد كله SKIPPED بأمانة
  // (الحقايق بتبقى: reusedMemory=true — والنتيجة النهائية بتندرج في END)
  if (node.type === "OBSERVE" && result.outcome === "SUCCESS" && mergedFacts.reusedMemory) {
    const skipTypes = ["DISCOVER", "VERIFY", "ENRICH", "QUALIFY", "SCORE", "RESEARCH", "CONTACT"]
    const toSkip = await db.taskGraphNode.findMany({ where: { graphId, status: "PENDING", type: { in: skipTypes } } })
    for (const n of toSkip) {
      await db.taskGraphNode.update({
        where: { id: n.id },
        data: { status: "SKIPPED", outcome: "SKIPPED", outcomeData: { note: "ذاكرة كافية غطت الهدف — صفر بحث ويب (43.5: الroute اختار من الحقايق)" } as never },
      }).catch(() => undefined)
    }
    if (toSkip.length) {
      await addEvent(graphId, node.nodeId, "DECISION", `ذاكرة كافية → تخطي ${toSkip.length} عقدة صيد (مسار مختصر بالحقايق)`)
      await mergeFacts(graphId, { leadsCreated: 0 })
    }
  }

  // END ناجح = إنهاء الخريطة
  if (node.type === "END" && nodeStatus === "DONE") {
    await finalizeGraph(graphId, "COMPLETED")
  }
  return { nodeId: node.nodeId, outcome: result.outcome, note: result.note }
}

// ═══ إعادة التخطيط — خريطة مسارات 43.14 حرفيًا ═══
async function replan(
  graphId: string,
  nodeId: string,
  nodeType: string,
  outcome: string,
  facts: GraphFacts,
): Promise<void> {
  const graph = await db.taskGraph.findUnique({ where: { id: graphId }, select: { stats: true, status: true } })
  if (!graph || graph.status !== "ACTIVE") return
  const stats = (graph.stats ?? {}) as { replans?: number }
  const replans = stats.replans ?? 0
  if (replans >= DSI_BUDGET.maxReplansPerGraph) return

  let insert: { type: string; objective: string; deps: string[]; priority: number } | null = null
  let stopGraph = false

  switch (outcome) {
    case "INSUFFICIENT_EVIDENCE":
      if (nodeType === "VERIFY") {
        // التحقق نفسه فشل → مصادر بديلة بدل VERIFY إضافي (منع حلقة مفرغة)
        insert = { type: "DISCOVER", objective: "صيد بمصادر بديلة بعد أدلة غير كافية (إعادة تخطيط)", deps: [nodeId], priority: 7 }
      } else if (nodeType === "DECIDE") {
        insert = { type: "DISCOVER", objective: "صيد بمنصات/استعلامات بديلة بعد قرار صفر ليدز", deps: [nodeId], priority: 7 }
      } else {
        insert = { type: "VERIFY", objective: "تحقق إضافي بعد أدلة غير كافية", deps: [nodeId], priority: 7 }
      }
      break
    case "MISSING_CAPABILITY":
      insert = { type: "RETRIEVE_SKILLS", objective: "استرجاع مهارة بديلة للقدرة الناقصة من GitSkills", deps: [nodeId], priority: 6 }
      break
    case "SOURCE_FAILURE":
      insert = { type: "RECOVER", objective: "فحص صحة المصادر/الحسابات واختيار مصدر بديل", deps: [nodeId], priority: 6 }
      break
    case "ACCOUNT_FAILURE":
      insert = { type: "RECOVER", objective: "فحص صحة الحساب (COOLDOWN/BLOCK) قبل أي محاولة جديدة", deps: [nodeId], priority: 8 }
      break
    case "AUTH_REQUIRED":
      insert = { type: "HUMAN_REVIEW", objective: "بوابة موافقة بشرية مطلوبة", deps: [nodeId], priority: 10 }
      break
    case "POLICY_BLOCK":
      stopGraph = true
      break
    default:
      return // نجاح/جزئي/م تخطى — مفيش إعادة تخطيط
  }

  if (stopGraph) {
    await db.taskGraph.update({ where: { id: graphId }, data: { status: "STOPPED", finalResult: { stopped: true, reason: "POLICY_BLOCK", at: nodeId } as never } })
    await addEvent(graphId, nodeId, "REPLAN", "POLICY_BLOCK → إيقاف الخريطة (السياسة فوق كل مهارة — 43.13)")
    return
  }
  if (!insert) return

  // منع التكرار اللانهائي: نفس (النوع + الهدف المختصر) مش بيتضاف مرتين
  const existing = await db.taskGraphNode.findMany({ where: { graphId }, select: { type: true, objective: true, nodeId: true } })
  const dup = existing.some((n) => n.type === insert!.type && n.objective.slice(0, 40) === insert!.objective.slice(0, 40))
  if (dup) {
    // اتجرّبت قبل كده → الخريطة تكمل اللي بعده (المسارات البديلة خلصت)
    await addEvent(graphId, nodeId, "REPLAN", `مسار بديل ${insert.type} موجود بالفعل — تجاهل لمنع الحلقة`)
    return
  }
  if (existing.length >= DSI_BUDGET.maxNodesPerGraph) return

  const nextId = `R${replans + 1}_${insert.type}`
  await db.taskGraphNode.create({
    data: {
      graphId, nodeId: nextId, parentNodeId: nodeId, type: insert.type, objective: insert.objective,
      dependencies: insert.deps as never, priority: insert.priority, policyGate: "STANDARD",
      verificationCriteria: [insert.objective.slice(0, 60)] as never, status: "PENDING",
      nextRoutes: { insertedBy: "REPLAN", afterOutcome: outcome } as never,
    },
  })
  await db.taskGraph.update({ where: { id: graphId }, data: { stats: { ...(graph.stats as object ?? {}), replans: replans + 1 } as never } })
  await addEvent(graphId, nodeId, "REPLAN", `${outcome} → إضافة عقدة ${insert.type}: ${insert.objective}`)
}

/** إنهاء الخريطة: النتيجة النهائية + ملخص إحصائي */
async function finalizeGraph(graphId: string, status: "COMPLETED" | "FAILED") {
  const nodes = await db.taskGraphNode.findMany({ where: { graphId }, select: { status: true, outcome: true } })
  const done = nodes.filter((n) => n.status === "DONE").length
  const failed = nodes.filter((n) => n.status === "FAILED").length
  const g = await db.taskGraph.findUnique({ where: { id: graphId }, select: { facts: true, stats: true, goal: true } })
  const facts = (g?.facts ?? {}) as GraphFacts
  await db.taskGraph.update({
    where: { id: graphId },
    data: {
      status,
      finalResult: {
        leads: facts.leadsCreated ?? 0,
        bestScore: facts.bestScore ?? 0,
        avgScore: facts.avgScore ?? 0,
        contactsHarvested: facts.contactsHarvested ?? 0,
        researchEnqueued: Boolean(facts.researchEnqueued),
        nodesDone: done,
        nodesFailed: failed,
      } as never,
      stats: { ...((g?.stats ?? {}) as object), done, failed, total: nodes.length } as never,
    },
  }).catch(() => undefined)
  await addEvent(graphId, null, "SUMMARY", `الخريطة ${status === "COMPLETED" ? "اكتملت" : "فشلت"}: ${done}/${nodes.length} عقدة، ${failed} فاشلة`)
}

// ═══ شريحة تشغيل: نفّذ عقد لحد الميزانية (تُستخدم من الأيجنت والنبضة) ═══
export async function runGraphSlice(
  graphId: string,
  opts?: { budgetMs?: number; maxNodes?: number; platformsHint?: string[] },
): Promise<{ steps: Array<{ nodeId: string; type: string; outcome: string; note: string }>; status: string }> {
  const budget = opts?.budgetMs ?? 95_000
  const maxNodes = opts?.maxNodes ?? 20
  const deadline = Date.now() + budget
  const steps: Array<{ nodeId: string; type: string; outcome: string; note: string }> = []
  let status = "ACTIVE"

  for (let i = 0; i < maxNodes; i++) {
    const graph = await db.taskGraph.findUnique({ where: { id: graphId }, select: { status: true } })
    if (!graph || graph.status !== "ACTIVE") { status = graph?.status ?? "MISSING"; break }
    if (i > 0 && Date.now() > deadline) { steps.push({ nodeId: "-", type: "BUDGET", outcome: "PAUSED", note: "ميزانية الوقت خلصت — الباقي النبضة الجاية (استئناف تلقائي)" }); break }
    const r = await executeNodeStep(graphId, opts?.platformsHint)
    if (!r) {
      // مفيش عقد جاهزة: إما كلها خلصت أو متعطلة
      const { ready, nodes } = await selectRoute(graphId)
      const pending = nodes.filter((n) => n.status === "PENDING").length
      const running = nodes.filter((n) => n.status === "RUNNING").length
      if (!ready.length && !pending && !running) status = await db.taskGraph.findUnique({ where: { id: graphId }, select: { status: true } }).then((g) => g?.status ?? "ACTIVE")
      else if (!ready.length && pending) {
        // عقد مستنية اعتمادات فاشلة → أنهي الخريطة بإحصاء صادق
        await finalizeGraph(graphId, "FAILED")
        status = "FAILED"
      } else status = "ACTIVE"
      break
    }
    const nodeRow = await db.taskGraphNode.findFirst({ where: { graphId, nodeId: r.nodeId }, select: { type: true } })
    steps.push({ nodeId: r.nodeId, type: nodeRow?.type ?? "?", outcome: r.outcome, note: r.note })
    const g2 = await db.taskGraph.findUnique({ where: { id: graphId }, select: { status: true } })
    if (g2 && g2.status !== "ACTIVE") { status = g2.status; break }
  }
  return { steps, status }
}

/** تشغيل كامل: بناء + تنفيذ — الواجهة المستخدمة من الأيجنت والأدوات */
export async function runAgentGraph(
  workspaceId: string,
  goal: string,
  opts?: { trigger?: string; sourceRunId?: string; platforms?: string[]; budgetMs?: number },
): Promise<{ graphId: string; builtBy: string; status: string; steps: Array<{ nodeId: string; type: string; outcome: string; note: string }>; finalResult: Record<string, unknown> | null }> {
  const built = await buildThinkingGraph(workspaceId, goal, opts)
  const slice = await runGraphSlice(built.graphId, { budgetMs: opts?.budgetMs ?? 95_000, platformsHint: opts?.platforms })
  const g = await db.taskGraph.findUnique({ where: { id: built.graphId }, select: { status: true, finalResult: true } })
  return {
    graphId: built.graphId,
    builtBy: built.builtBy,
    status: g?.status ?? slice.status,
    steps: slice.steps,
    finalResult: (g?.finalResult ?? null) as Record<string, unknown> | null,
  }
}

/** فحص الخريطة + إجابات أسئلة الوعي (43.16) — «بعمل إيه وليه؟» في أي لحظة */
export async function inspectThinkingGraph(graphId: string): Promise<{
  graph: Record<string, unknown>
  nodes: Array<Record<string, unknown>>
  awareness: GraphAwareness
} | null> {
  const graph = await db.taskGraph.findUnique({ where: { id: graphId } })
  if (!graph) return null
  const nodes = await db.taskGraphNode.findMany({ where: { graphId }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] })
  const events = await db.taskGraphEvent.findMany({ where: { graphId }, orderBy: { createdAt: "desc" }, take: 20 })
  const done = nodes.filter((n) => n.status === "DONE").length
  const failed = nodes.filter((n) => n.status === "FAILED").length
  const pending = nodes.filter((n) => n.status === "PENDING").length
  const current = nodes.find((n) => n.status === "RUNNING") ?? nodes.find((n) => n.status === "PENDING" && (n.dependencies as string[] | null ?? []).every((d) => nodes.find((x) => x.nodeId === d)?.status !== "PENDING"))
  const lastSkillEvent = events.find((e) => e.type === "SKILL_SELECTED")
  const facts = (graph.facts ?? {}) as GraphFacts
  const lastDecision = events.find((e) => e.type === "EVIDENCE" || e.type === "REPLAN")
  const awareness: GraphAwareness = {
    whatAmIDoing: current ? `${current.type}: ${current.objective}` : `الخريطة ${graph.status}`,
    whyAmIDoingIt: `الهدف: ${graph.goal.slice(0, 120)} — بُنيت ${String((graph.stats as { builtBy?: string } | null)?.builtBy ?? "TEMPLATE")}`,
    currentNode: current ? { id: current.nodeId, type: current.type, objective: current.objective.slice(0, 120), status: current.status } : null,
    currentSkill: lastSkillEvent ? (() => {
      const sel = ((lastSkillEvent.payload as { selected?: Array<{ name: string; kind: string; selectionReason: string }> })?.selected ?? [])[0]
      return sel ? { name: sel.name, kind: sel.kind, why: sel.selectionReason } : null
    })() : null,
    evidenceSummary: lastDecision ? lastDecision.message.slice(0, 200) : "لسه مفيش أدلة",
    blocking: failed ? `فشل ${failed} عقدة — آخر حدث: ${events.find((e) => e.type === "REPLAN" || e.type === "ERROR")?.message.slice(0, 120) ?? "غير معروف"}` : null,
    whatIsNext: (() => {
      const settled2 = new Set(nodes.filter((n) => ["DONE", "SKIPPED", "FAILED"].includes(n.status)).map((n) => n.nodeId))
      const nextNode = nodes.find((n) => n.status === "PENDING" && ((n.dependencies as string[] | null) ?? []).every((d) => settled2.has(d)))
      return nextNode ? `أقرب عقدة جاهزة: ${nextNode.type} — ${nextNode.objective.slice(0, 80)}` : pending ? "عقد مستنية اعتمادات" : "لا حاجة متبقية"
    })(),
    progress: { done, failed, pending, total: nodes.length },
  }
  return {
    graph: { id: graph.id, goal: graph.goal, status: graph.status, builtBy: (graph.stats as { builtBy?: string } | null)?.builtBy, facts, finalResult: graph.finalResult, assumptions: graph.assumptions },
    nodes: nodes.map((n) => ({ nodeId: n.nodeId, type: n.type, objective: n.objective, status: n.status, outcome: n.outcome, attempts: n.attempts, skills: (n.selectedSkills as SelectedSkillRef[] | null)?.map((s) => `${s.kind}:${s.name}`) ?? [], deps: n.dependencies })),
    awareness,
  }
}

/** استئناف الخرايط النشطة اللي اتقطعت (سيرفرless اتقتل نص تنفيذ) — النبضة بيناديها (43.17) */
export async function resumeActiveGraphs(max = 2, budgetMs = 40_000): Promise<Array<{ graphId: string; resumed: boolean; note: string }>> {
  const out: Array<{ graphId: string; resumed: boolean; note: string }> = []
  try {
    // عقد RUNNING عالقة من instance مات: اللي استنفدت محاولاتها = فشل نهائي، والباقي يرجع PENDING
    await db.taskGraphNode.updateMany({
      where: { status: "RUNNING", attempts: { gte: DSI_BUDGET.maxAttemptsPerNode } },
      data: { status: "FAILED", outcome: "FAILURE", failureReason: `استنفد المحاولات (${DSI_BUDGET.maxAttemptsPerNode}) — أثناء استئناف الخريطة` },
    })
    await db.taskGraphNode.updateMany({
      where: { status: "RUNNING", updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
      data: { status: "PENDING" },
    })
    const graphs = await db.taskGraph.findMany({
      where: { status: "ACTIVE", updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
      orderBy: { updatedAt: "asc" },
      take: max,
      select: { id: true },
    })
    for (const g of graphs) {
      const slice = await runGraphSlice(g.id, { budgetMs, maxNodes: 3 })
      out.push({ graphId: g.id, resumed: slice.steps.length > 0, note: `${slice.steps.length} عقدة اتنفذت — الحالة ${slice.status}` })
    }
  } catch (err) {
    out.push({ graphId: "-", resumed: false, note: `فشل الاستئناف: ${err instanceof Error ? err.message.slice(0, 100) : "خطأ"}` })
  }
  return out
}
