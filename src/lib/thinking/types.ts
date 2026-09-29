// LeadOS — عقد خريطة التفكير (Thinking Graph Contract — مواصفة 43.4)
// كل عقدة في الخريطة بتتحمل الحقول دي كلها قبل التنفيذ — «لا يُسمح بتنفيذ Node
// لم يتم تقييم احتياجاته» (43.5). الأنواع السبعة عشر هي مفردات الخريطة الوحيدة.
export const NODE_TYPES = [
  "OBSERVE", "ANALYZE", "PLAN", "RETRIEVE_SKILLS", "DISCOVER", "VERIFY", "ENRICH",
  "QUALIFY", "SCORE", "RESEARCH", "DECIDE", "CONTACT", "FOLLOWUP", "LEARN",
  "RECOVER", "HUMAN_REVIEW", "END",
] as const
export type NodeType = (typeof NODE_TYPES)[number]

export const NODE_OUTCOMES = [
  "SUCCESS", "PARTIAL", "FAILURE", "INSUFFICIENT_EVIDENCE", "MISSING_CAPABILITY",
  "SOURCE_FAILURE", "ACCOUNT_FAILURE", "AUTH_REQUIRED", "POLICY_BLOCK", "SKIPPED",
] as const
export type NodeOutcome = (typeof NODE_OUTCOMES)[number]

export type NodeStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED" | "BLOCKED" | "SKIPPED"

/** عقدة التنفيذ الكاملة (43.4) — نفس الحقول في كود التخزين TaskGraphNode */
export interface GraphNodeContract {
  nodeId: string
  parentNodeId?: string | null
  type: NodeType
  objective: string
  inputRequirements?: string[]
  requiredFacts?: string[]
  requiredSkills?: string[]
  tools?: string[]
  dependencies: string[] // الحواف الواردة — كلها لازم تخلص DONE قبل العقدة دي
  priority: number // 1-10 — أعلى يتنفذ الأول بين الجاهزين
  costEstimate: number // 1-5
  riskEstimate: number // 1-5
  expectedOutput?: string
  verificationCriteria: string[] // شروط إثبات النجاح
  policyGate: "STANDARD" | "STRICT" | "HUMAN_APPROVAL"
}

/** حقايق المهمة الحية — بتتحدّث بعد كل عقدة (أساس إعادة التخطيط 43.17) */
export interface GraphFacts {
  memoryHits?: number
  reusedMemory?: boolean
  city?: string | null
  industry?: string | null
  service?: string | null
  queries?: string[]
  platforms?: string[]
  altPlatforms?: string[]
  itemsScanned?: number
  leadsCreated?: number
  avgScore?: number
  bestScore?: number
  contactsHarvested?: number
  researchEnqueued?: boolean
  pausedGroups?: number
  [key: string]: unknown
}

/** إجابات أسئلة الوعي الأربعة عشر (43.16) — الـAI لازم يعرف يجاوبها في أي لحظة */
export interface GraphAwareness {
  whatAmIDoing: string
  whyAmIDoingIt: string
  currentNode: { id: string; type: string; objective: string; status: string } | null
  currentSkill: { name: string; kind: string; why: string } | null
  evidenceSummary: string
  blocking: string | null
  whatIsNext: string
  progress: { done: number; failed: number; pending: number; total: number }
}

export const isNodeType = (v: string): v is NodeType => (NODE_TYPES as readonly string[]).includes(v)
