// LeadOS — ميزانيات طبقة الذكاء الديناميكية (مواصفة 43.19)
// المبدأ: QUALITY > QUANTITY — «JUST IN TIME / JUST ENOUGH / JUST FOR THIS NODE»
// الحدود دي بتمنع: تحميل كل المكتبة، استخدام مهارات «احتياطيًا»، أو تضخيم البرومبتات.
export const DSI_BUDGET = {
  /** أقصى عدد مهارات خارجية مفعّلة لمهمة واحدة (كل عقد الخريطة) */
  maxSkillsPerTask: 8,
  /** أقصى عدد مهارات لعقدة واحدة — Minimum Sufficient Skill Set */
  maxSkillsPerNode: 3,
  /** أقصى حرف مسموح لمحتوى المهارات داخل برومبت العقدة الواحدة (~900 توكن) */
  maxSkillContextChars: 3600,
  /** أقصى مرشحين يتحملون الترتيب الكامل لكل استرجاع (قبل الترتيب النهائي) */
  maxRetrievalCandidates: 24,
  /** أقصى نداءات خارجية (استرجاع/تحقق) لخريطة واحدة — حماية من دوامة الاسترجاع */
  maxExternalSkillCalls: 12,
  /** ميزانية زمن استرجاع المهارات للعقدة الواحدة (ms) */
  skillRetrievalBudgetMs: 6_000,
  /** ميزانية زمن بناء الخريطة بالـAI (ms) — الفشل بيقتلعي للقالب الحتمي فورًا */
  graphBuildBudgetMs: 12_000,
  /** أقصى عدد عقد في خريطة واحدة */
  maxNodesPerGraph: 14,
  /** أقصى إعادة تخطيط لكل خريطة — بعدها الخريطة تتوقف بـSTOPPED بمسار بديل */
  maxReplansPerGraph: 6,
  /** أقصى محاولات لكل عقدة قبل ما تتعتبر فاشلة نهائيًا */
  maxAttemptsPerNode: 2,
  /** أقل درجة ثقة (0-100) تسمح بتفعيل مهارة خارجية */
  minTrustScore: 60,
  /** أقل درجة صلة نهائية تسمح باختيار مهارة (0-1) — تحتها = NO NEED → NO SKILL */
  minFinalScore: 0.42,
} as const

export type DsiBudgetKey = keyof typeof DSI_BUDGET
