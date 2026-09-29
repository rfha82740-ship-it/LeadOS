// LeadOS — باني خرايط التفكير (Graph Builder — مواصفة 43.3 / 43.20 / 43.5)
// الخريطة ليست ثابتة: بتتبني لكل Task حسب الهدف والقيود والمصادر والحقايق.
// الطريق: Master AI يحاول يبني خريطة مخصصة (JSON) — وأي فشل/خلل = القالب الحتمي
// (نفس خط أنابيب الصيد المثبت) فورًا. فشل الـAI عمروا ما بيفشّل المهمة (43.28 #20).
import { db } from "@/lib/db"
import { aiChatJson } from "@/lib/ai"
import { DSI_BUDGET } from "@/lib/skills/dsi/budget"
import { parseTaskObjective } from "@/lib/skills/dsi/retriever"
import { isNodeType, type GraphNodeContract, type NodeType } from "./types"

export interface BuildResult {
  graphId: string
  builtBy: "AI" | "TEMPLATE"
  nodes: number
  assumptions: string[]
}

/** القالب الحتمي — خط أنابيب 43.20 بالظبط (12 عقدة) — مستخدم في fallback وسجل مقارنة للـAI */
export function defaultTemplate(objective: string): GraphNodeContract[] {
  const p = parseTaskObjective(objective)
  const researchWanted = true
  const raw: Array<Partial<GraphNodeContract> & Pick<GraphNodeContract, "nodeId" | "type" | "objective" | "dependencies" | "priority">> = [
    { nodeId: "N1", type: "OBSERVE", objective: "فحص الذاكرة والحقايق الحالية قبل أي بحث", dependencies: [], priority: 10, costEstimate: 1, riskEstimate: 1, verificationCriteria: ["تسجيل عدد ذكريات مشابهة أو «لا ذاكرة»"], tools: ["memory_search"] },
    { nodeId: "N2", type: "ANALYZE", objective: `فهم الهدف: استخراج الصناعة والمدينة والخدمة من «${objective.slice(0, 80)}»`, dependencies: ["N1"], priority: 9, costEstimate: 1, riskEstimate: 1, verificationCriteria: ["استخراج كيان واحد على الأقل أو تسجيل هدف عام"], tools: [] },
    { nodeId: "N3", type: "PLAN", objective: "بناء الاستعلامات واختيار المنصات + استرجاع مهارات الخطة", dependencies: ["N2"], priority: 8, costEstimate: 2, riskEstimate: 1, verificationCriteria: ["استعلام واحد صالح على الأقل", "قائمة منصات غير فاضية"], tools: ["aiSelectPlatforms"] },
    { nodeId: "N4", type: "DISCOVER", objective: `صيد ${p.domain === "general" ? "عملاء" : p.domain} عبر المنصات المختارة`, dependencies: ["N3"], priority: 7, costEstimate: 5, riskEstimate: 2, verificationCriteria: ["عناصر ممسوحة > 0"], tools: ["lead_hunt"] },
    { nodeId: "N5", type: "VERIFY", objective: "التحقق من وجود أدلة صيد فعلية (ليدز أو مسح حقيقي)", dependencies: ["N4"], priority: 7, costEstimate: 1, riskEstimate: 1, verificationCriteria: ["ليد جديد ≥ 1 أو إثبات مسح كافٍ"], tools: [] },
    { nodeId: "N6", type: "ENRICH", objective: "إثراء أفضل الليدز الجديدة ببيانات تواصل من مواقعها", dependencies: ["N5"], priority: 6, costEstimate: 3, riskEstimate: 2, verificationCriteria: ["محاولة إثراء أو غياب مواقع للإثراء"], tools: ["crawl_page"] },
    { nodeId: "N7", type: "QUALIFY", objective: "إعادة حساب درجات التأهيل للليدز الجديدة", dependencies: ["N5"], priority: 6, costEstimate: 1, riskEstimate: 1, verificationCriteria: ["ليد واحد على الأقل اتحسب درجته"], tools: [] },
    { nodeId: "N8", type: "SCORE", objective: "تجميع متوسط وأعلى درجة لليدز الجديدة", dependencies: ["N6", "N7"], priority: 5, costEstimate: 1, riskEstimate: 1, verificationCriteria: ["حساب متوسط وأعلى درجة"], tools: [] },
    { nodeId: "N9", type: "RESEARCH", objective: researchWanted ? "فتح بحث عميق لأعلى ليد لو تجاوز بوابة القيمة" : "تخطي البحث العميق", dependencies: ["N8"], priority: 5, costEstimate: 3, riskEstimate: 2, verificationCriteria: ["قرار بحث مسجل (فُتح أو استُبعد بالسبب)"], tools: ["DEEP_RESEARCH"] },
    { nodeId: "N10", type: "DECIDE", objective: "بوابة القرار: تكملة لبيع/إعادة تخطيط/إيقاف بالسياسة", dependencies: ["N9"], priority: 6, costEstimate: 1, riskEstimate: 1, verificationCriteria: ["قرار مسجل مع سبب"], tools: [] },
    { nodeId: "N11", type: "LEARN", objective: "تثبيت نتايج المهارات المستخدمة + درس الاستعلام الأفضل", dependencies: ["N10"], priority: 4, costEstimate: 1, riskEstimate: 1, verificationCriteria: ["تسجيل نتايج المهارات"], tools: [] },
    { nodeId: "N12", type: "END", objective: "إنهاء الخريطة وتجميع النتيجة النهائية", dependencies: ["N11"], priority: 3, costEstimate: 1, riskEstimate: 1, verificationCriteria: ["ملخص نهائي مسجل"], tools: [] },
  ]
  return raw.map((n) => ({
    nodeId: n.nodeId,
    type: n.type,
    objective: n.objective,
    dependencies: n.dependencies,
    priority: n.priority,
    parentNodeId: n.dependencies[n.dependencies.length - 1] ?? null,
    inputRequirements: [],
    requiredFacts: [],
    requiredSkills: [],
    tools: n.tools ?? [],
    costEstimate: n.costEstimate ?? 1,
    riskEstimate: n.riskEstimate ?? 1,
    expectedOutput: n.verificationCriteria?.[0] ?? "",
    verificationCriteria: n.verificationCriteria ?? [],
    policyGate: "STANDARD" as const,
  }))
}

/** فحص خلو الخريطة من الدورات (Kahn) + صحة الاعتمادات — أي عقدة يتيمة تُصلح */
function sanitizeGraph(raw: GraphNodeContract[], objective: string): { nodes: GraphNodeContract[]; fixes: string[] } {
  const fixes: string[] = []
  const byId = new Map<string, GraphNodeContract>()
  for (const n of raw) {
    let type: NodeType = isNodeType(n.type) ? n.type : "ANALYZE"
    if (!isNodeType(n.type)) fixes.push(`${n.nodeId}: نوع غير معروف «${n.type}» → ANALYZE`)
    const id = /^[A-Z]\d+$/i.test(n.nodeId ?? "") ? n.nodeId.toUpperCase() : `N${byId.size + 1}`
    byId.set(id, { ...n, nodeId: id, type, dependencies: [], objective: String(n.objective ?? objective).slice(0, 300) })
  }
  for (const n of byId.values()) {
    const deps = (n.dependencies ?? []).map((d) => String(d).toUpperCase()).filter((d) => byId.has(d) && d !== n.nodeId)
    n.dependencies = [...new Set(deps)].slice(0, 4)
    n.priority = Math.max(1, Math.min(10, Math.round(n.priority ?? 5)))
    if (!n.verificationCriteria?.length) n.verificationCriteria = [`اكتمال: ${n.objective.slice(0, 60)}`]
    n.policyGate = n.policyGate === "HUMAN_APPROVAL" || n.policyGate === "STRICT" ? n.policyGate : "STANDARD"
  }
  // كشف الدورات: أي عقدة في دورة تُقطع حوافها
  const visited = new Set<string>()
  const stack = new Set<string>()
  const dfs = (id: string) => {
    if (visited.has(id)) return
    stack.add(id)
    for (const d of byId.get(id)?.dependencies ?? []) {
      if (stack.has(d)) {
        fixes.push(`${id}: حافة دورة لـ${d} اتنقت`)
        byId.get(id)!.dependencies = byId.get(id)!.dependencies.filter((x) => x !== d)
      } else dfs(d)
    }
    stack.delete(id)
    visited.add(id)
  }
  for (const id of byId.keys()) dfs(id)
  // لو فاضية كلها بعد التنضيف → القالب
  const nodes = [...byId.values()].slice(0, DSI_BUDGET.maxNodesPerGraph)
  if (!nodes.length) return { nodes: defaultTemplate(objective), fixes: [...fixes, "خريطة AI فاضية → القالب الحتمي"] }
  return { nodes, fixes }
}

/**
 * بناء الخريطة: AI أولًا (بميزانية زمن صارمة) — وفشله/بطلانه = القالب الحتمي فورًا.
 * الخريطة بتتخزن كاملة بعقدها (43.16: كل مهمة ليها TaskGraph).
 */
export async function buildThinkingGraph(
  workspaceId: string,
  goal: string,
  opts?: { trigger?: string; sourceRunId?: string; platforms?: string[] },
): Promise<BuildResult> {
  const parsed = parseTaskObjective(goal)
  let builtBy: "AI" | "TEMPLATE" = "TEMPLATE"
  let nodes = defaultTemplate(goal)
  const assumptions: string[] = [
    parsed.platform ? `المنصة الأساسية: ${parsed.platform}` : "لا منصة محددة — الانتقال بقرار PLAN",
    `النطاق: ${parsed.domain} | الفعل: ${parsed.action}`,
    "سوق مصري — لغة عربية مصرية للتواصل",
  ]

  // ═══ Master AI يبني خريطة مخصصة — بحد زمن صارم ═══
  try {
    const result = await aiChatJson<{ assumptions?: string[]; nodes?: Array<Partial<GraphNodeContract>> }>(
      [
        {
          role: "system",
          content:
            "أنت مهندس خرايط تنفيذ في LeadOS (منصة صيد عملاء مصرية). مهمتك: لبن الهدف إلى خريطة عقد لتنفيذ فعلي.\n" +
            "الأنواع المسموحة فقط: OBSERVE ANALYZE PLAN RETRIEVE_SKILLS DISCOVER VERIFY ENRICH QUALIFY SCORE RESEARCH DECIDE CONTACT FOLLOWUP LEARN RECOVER HUMAN_REVIEW END\n" +
            "القواعد: (1) كل عقدة dependencies = معرفات عقد سابقة حقيقية. (2) أول عقدة OBSERVE بدون اعتمادات. (3) 6-12 عقدة. (4) آخر عقدة END. (5) العقد التنفيذية الحقيقية: DISCOVER (صيد) ENRICH (إثراء تواصل) RESEARCH (بحث عميق) QUALIFY/SCORE. (6) كل عقدة verificationCriteria = شروط قابلة للفحص الآلي.\n" +
            "مهم: DISCOVER يقدر يستدعي أداة lead_hunt بمنصات من: GOOGLE_MAPS GOOGLE_SEARCH FACEBOOK INSTAGRAM LINKEDIN REDDIT TIKTOK YOUTUBE DIRECTORY JOBS NEWS MARKETPLACE FREELANCE.\n" +
            'ارجع JSON فقط بالشكل: {"assumptions":["..."],"nodes":[{"nodeId":"N1","type":"OBSERVE","objective":"...","dependencies":[],"priority":10,"verificationCriteria":["..."]}]}',
        },
        { role: "user", content: `الهدف: ${goal}\nالنطاق المكتشف: ${JSON.stringify(parsed)}` },
      ],
      { workspaceId, runType: "GRAPH_BUILD", temperature: 0.2, maxTokens: 900, task: "reason" },
    )
    const rawNodes = result?.nodes ?? []
    if (Array.isArray(rawNodes) && rawNodes.length >= 4) {
      const candidate: GraphNodeContract[] = rawNodes.map((n, i) => ({
        nodeId: String(n.nodeId ?? `N${i + 1}`).toUpperCase(),
        parentNodeId: null,
        type: String(n.type ?? "ANALYZE") as NodeType,
        objective: String(n.objective ?? goal).slice(0, 300),
        inputRequirements: [],
        requiredFacts: [],
        requiredSkills: Array.isArray(n.requiredSkills) ? n.requiredSkills.map(String).slice(0, 4) : [],
        tools: Array.isArray(n.tools) ? n.tools.map(String).slice(0, 4) : [],
        dependencies: Array.isArray(n.dependencies) ? n.dependencies.map(String) : [],
        priority: Number(n.priority ?? 5),
        costEstimate: Number(n.costEstimate ?? 2),
        riskEstimate: Number(n.riskEstimate ?? 2),
        expectedOutput: String(n.expectedOutput ?? ""),
        verificationCriteria: Array.isArray(n.verificationCriteria) ? n.verificationCriteria.map(String).slice(0, 4) : [],
        policyGate: n.policyGate === "HUMAN_APPROVAL" ? "HUMAN_APPROVAL" : n.policyGate === "STRICT" ? "STRICT" : "STANDARD",
      }))
      const clean = sanitizeGraph(candidate, goal)
      nodes = clean.nodes
      assumptions.push(...(result?.assumptions ?? []).slice(0, 4).map(String))
      if (opts?.platforms?.length) assumptions.push(`منصات مفروضة من الطلب: ${opts.platforms.join(", ")}`)
      builtBy = "AI"
      if (clean.fixes.length) assumptions.push(`تعديلات بناء: ${clean.fixes.slice(0, 3).join(" | ")}`)
    }
  } catch { /* AI فشل → القالب (مسجل كحدث أسفل) */ }

  // ═══ التخزين: الخريطة + العقد ═══
  const graph = await db.taskGraph.create({
    data: {
      workspaceId,
      goal: goal.slice(0, 1000),
      status: "ACTIVE",
      trigger: opts?.trigger ?? "AGENT",
      sourceRunId: opts?.sourceRunId,
      assumptions: assumptions as unknown as never,
      facts: {} as never,
      stats: { builtBy, replans: 0, skillsExternalUsed: 0 } as never,
    },
  })
  for (const n of nodes) {
    await db.taskGraphNode.create({
      data: {
        graphId: graph.id,
        nodeId: n.nodeId,
        parentNodeId: n.parentNodeId,
        type: n.type,
        objective: n.objective,
        inputRequirements: (n.inputRequirements ?? []) as never,
        requiredFacts: (n.requiredFacts ?? []) as never,
        requiredSkills: (n.requiredSkills ?? []) as never,
        tools: (n.tools ?? []) as never,
        dependencies: n.dependencies as never,
        priority: n.priority,
        costEstimate: n.costEstimate,
        riskEstimate: n.riskEstimate,
        expectedOutput: n.expectedOutput,
        verificationCriteria: n.verificationCriteria as never,
        policyGate: n.policyGate,
        status: "PENDING",
      },
    })
  }
  await db.taskGraphEvent.create({
    data: {
      graphId: graph.id,
      type: "DECISION",
      message: `خريطة اتبنت (${builtBy === "AI" ? "بواسطة Master AI" : "بالقالب الحتمي"}) بـ${nodes.length} عقدة`,
      payload: { builtBy, nodes: nodes.length, assumptions } as never,
    },
  })
  return { graphId: graph.id, builtBy, nodes: nodes.length, assumptions }
}
