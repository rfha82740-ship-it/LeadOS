// LeadOS — Farm Inventory (Final Hardening #3/#4): مصدر الحقيقة الوحيد لجرد العمال
// الأرقام محسوبة من التهيئة الفعلية: browser-farm.yml (matrix 15 shard × 2 parts) + worker/farm.py
// ممنوع أي عرض "30 متصفح" — الأرقام بالأنواع الحقيقية فقط.
// مطابقة مع scripts/system-audit.ts وscripts/final-production-audit.ts (التدقيق بيتحقق من التطابق).
export const FARM_INVENTORY = {
  /** matrix shards في browser-farm.yml */
  githubMatrixJobs: 15,
  /** farm.py processes لكل shard (--part 0/1) */
  workerProcessesPerShard: 2,
  /** إجمالي عمليات العمال في جيل كامل: 15 × 2 */
  workerProcessesTotal: 30,
  /** شاردات متصفح حقيقية (DrissionPage/Chrome): JOBS, MARKETPLACE, FREELANCE, DIRECTORY */
  browserShards: ["JOBS", "MARKETPLACE", "FREELANCE", "DIRECTORY"],
  /** نسخ كروم حقيقية: 4 شاردات × 2 parts */
  browserInstances: 8,
  /** شاردات SERP (DuckDuckGo HTML عبر FlareSolverr): quora, discord, events, youtube, tiktok, linkedin, instagram, x, facebook */
  serpShards: ["QUORA", "DISCORD", "EVENTS", "YOUTUBE", "TIKTOK", "LINKEDIN", "INSTAGRAM", "X", "FACEBOOK"],
  /** عمال SERP: 9 شاردات × 2 parts */
  serpWorkers: 18,
  /** شاردات HTTP مباشر (requests بدون متصفح): telegram, reddit */
  httpShards: ["TELEGRAM", "REDDIT"],
  /** عمال HTTP: 2 شاردات × 2 parts */
  httpWorkers: 4,
  /** FlareSolverr: service container واحد لكل shard job (localhost:8191) — مش متصفح */
  flaresolverrInstances: 15,
  flaresolverrModel: "1 لكل shard job (service container) — مشتركة بين عملي part 0/1 لنفس الجوب؛ FlareSolverr بيعالج الطلبات داخليًا بالتسلسل (محتوى مشترك = أزمنة انتظار أطول تحت الضغط)",
  /** سلاسل أخرى: 5 سلاسل × 1 جوب */
  otherChainJobs: 5,
} as const

/** الملخص الرسمي المعروض في UI والتقارير — بنفس التعريفات في كل مكان */
export function farmInventorySummary() {
  const f = FARM_INVENTORY
  return {
    githubActionsJobsPerGeneration: f.githubMatrixJobs + f.otherChainJobs,
    farmWorkerProcesses: f.workerProcessesTotal,
    browserInstances: f.browserInstances, // كروم حقيقي فقط — ممنوع خلطه بالعمال
    chromeInstances: f.browserInstances,
    httpWorkers: f.httpWorkers,
    serpWorkers: f.serpWorkers,
    flaresolverrInstances: f.flaresolverrInstances,
    definitions: {
      browserInstance: "نسخة Chromium/Chrome حقيقية تفتح صفحات (DrissionPage) — 8 فقط",
      serpWorker: "عملية تطلب نتائج بحث (DuckDuckGo) — طلب HTTP مش متصفح",
      httpWorker: "عملية تطلب API/صفحات مباشرة (telegram/reddit) — طلب HTTP مش متصفح",
      flaresolverr: "حاوية service لحل تحديات الحجب — مش متصفح LeadOS وعمالها بيستخدموه كوسيط",
    },
  }
}
