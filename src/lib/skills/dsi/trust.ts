// LeadOS — بوابة ثقة المهارات الخارجية (Skill Trust Gate — مواصفة 43.8 / 43.9 / 43.18)
// القاعدة الصارمة: «لا تثق في أي Skill تلقائيًا». المهارة الخارجية تقدّم Knowledge /
// Procedure / Strategy فقط — لكنها لا تصبح Authority أبدًا. السلطة دايمًا لـ:
// Master AI + Policy Engine + الطبقة الأمنية الحتمية.
//
// الفحص بيمر بالمراحل: صيغة ← مصدر ← محتوى ← رخصة ← حقن تعليمات ← صلاحيات أدوات
// ← أفعال شبكية ← أمان تنفيذ ← درجة ثقة. أي نمط تنفيذ/تسريب = رفض فوري.
// scripts/references/assets جوه أي مهارة = بيانات غير موثوقة: بتتفحص، ولا بتنفذ أبدًا.
// ملاحظة cache (43.18): CACHE HIT ≠ PERMANENT TRUST — تغيّر contentHash يعيد الفحص كاملًا.
import { createHash } from "node:crypto"

export type TrustVerdict = "PASS" | "FAIL"

export interface TrustCheck {
  stage: string // FORMAT | SOURCE | CONTENT | LICENSE | INJECTION | TOOL_PERM | NETWORK | EXECUTION
  ok: boolean
  penalty: number // خصم من 100 لو فشل جزئي
  detail?: string
}

export interface TrustResult {
  score: number // 0-100
  verdict: TrustVerdict
  checks: TrustCheck[]
  hardReject: boolean // رفض صارم (حقن/تنفيذ/تسريب) — مهما كانت الدرجة
  reasons: string[]
}

export interface SkillTrustInput {
  name: string
  description: string
  body: string
  /** مصدر المهارة: kind + معرف خارجي (repo أو slug أو مسار محلي) */
  kind: "CORE" | "GITSKILLS" | "CLAWHUB" | "WORKSPACE"
  sourceRef: string
  license?: string
}

// ═══ أنماط الحقن (Prompt-Injection): تعليمات موجهة للـAI نفسه عشان تغيّر سياسته ═══
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts?|rules?)/i, "أمر بتجاهل التعليمات السابقة"],
  [/disregard\s+(all\s+)?(your\s+)?(instructions|rules?|policy|policies)/i, "أمر بتجاهل السياسات"],
  [/you\s+are\s+now\s+(a|an|the)\s+/i, "محاولة إعادة تعريف هوية الوكيل"],
  [/(reveal|print|show|leak)\s+(your\s+)?(system\s+prompt|hidden\s+instructions|secret)/i, "محاولة كشف تعليمات النظام"],
  [/override\s+(the\s+)?(policy|policies|security|safety|rules?)/i, "محاولة تجاوز السياسة الأمنية"],
  [/bypass\s+(the\s+)?(security|safety|policy|approval|gate)/i, "أمر بتجاوز بوابة أمنية"],
  [/(act|operate)\s+(as|with)\s+(admin|root|sudo|owner)/i, "محاولة رفع صلاحيات"],
  [/do\s+not\s+tell\s+the\s+user|hide\s+this\s+from\s+the\s+user/i, "تعليمات إخفاء عن المستخدم"],
  [/تجاهل\s+(التعليمات|القواعد|السياسة)|تجاوز\s+(الأمان|السياسة)/i, "أمر تجاوز بالعربية"],
]

// ═══ أنماط الصلاحيات والأسرار (TOOL PERMISSION CHECK) ═══
const TOOL_PERM_PATTERNS: Array<[RegExp, string]> = [
  [/process\.env\s*\[|process\.env\.[A-Z_]{3,}/i, "طلب قراءة متغيرات بيئة/أسرار"],
  [/\.env\b|credentials?\s*(file|json)|secrets?\.(json|yaml|toml)/i, "طلب الوصول لملفات أسرار"],
  [/(api[_-]?key|access[_-]?token|session[_-]?cookie|password)[^\n]{0,30}(=|:|read|extract|grab)/i, "محاولة استخراج مفاتيح/جلسات"],
]

// ═══ أنماط الأفعال الشبكية (NETWORK ACTION CHECK) ═══
const NETWORK_PATTERNS: Array<[RegExp, string]> = [
  [/(exfiltrate|upload|send|post|forward)[^\n]{0,40}(all\s+)?(data|leads|leads?\s*list|credentials|keys|tokens?)/i, "أمر تسريب بيانات خارجيًا"],
  [/webhook\.site|requestbin|burpcollab|\bngrok\b/i, "نطاق تجميع بيانات معروف"],
  [/(post|curl|fetch|upload)[^\n]{0,60}(https?:\/\/)[^\s]{10,}/i, "أمر إرسال شبكي صريح"],
]

// ═══ أنماط التنفيذ (EXECUTION SAFETY CHECK) — نفس روح بوابة ClawHub وأشد ═══
// القاعدة: لازم صيغة قابلة للتنفيذ فعليًا (استدعاء/استيراد/أمر) — الكلام الأكاديمي عن المفهوم مش جريمة
const EXECUTION_PATTERNS: Array<[RegExp, string]> = [
  [/curl\s+[^\n]*\|\s*(ba)?sh|wget\s+[^\n]*\|\s*(ba)?sh/i, "تحميل وتنفيذ سكريبت من الإنترنت"],
  [/\b(bash|sh|zsh|powershell)\s+-c\b/i, "تنفيذ أوامر شل مباشرة"],
  [/\beval\s*\(|new\s+Function\s*\(/i, "تنفيذ كود ديناميكي"],
  [/os\.system|subprocess\.(run|call|Popen)|require\s*\(\s*['"]child_process['"]|from\s+['"]child_process['"]|child_process\.(exec|spawn|fork)|execSync|spawnSync/i, "تشغيل عمليات نظام"],
  [/\brm\s+-rf\s+[~\/]/i, "أمر حذف خطير"],
  [/npm\s+install[^\n]*&&|pip\s+install[^\n]*&&/i, "تثبيت حزم وتشغيل متسلسل"],
  [/keystore|metamask|seed\s*phrase|wallet\s*(seed|mnemonic)/i, "محاولة الوصول لمحافظ"],
  [/xox[baprs]-[a-zA-Z0-9-]{10,}|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{30,}/i, "أنماط مفاتيح حقيقية جوه المحتوى"],
]

// ═══ أنماط بيانات الاعتماد السحابية (CLOUD CREDENTIAL ACCESS) ═══
const CLOUD_CRED_PATTERNS: Array<[RegExp, string]> = [
  [/AWS_(SECRET_)?ACCESS[_\-]?KEY(_ID)?|AZURE_(CLIENT_)?SECRET|GOOGLE_APPLICATION_CREDENTIALS|GCLOUD\s+AUTH|\.aws\/credentials/i, "محاولة الوصول لبيانات اعتماد سحابية"],
  [/169\.254\.169\.254|metadata\.google\.internal/i, "محاولة الوصول لنقطة نهاية بيانات الحساب السحابية"],
]

// ═══ فحص المصدر: قائمة المصادر المسموح بها لمكتبات المهارات ═══
const TRUSTED_SOURCE_KINDS: Record<SkillTrustInput["kind"], number> = {
  CORE: 0, // المهارات المحلية البندل — سجل المشروع نفسه
  WORKSPACE: 0, // مهارات الورشة الخاصة
  CLAWHUB: 2, // سجل منسّق بفلتر isSuspicious — خصم رمزي
  GITSKILLS: 5, // مستودع مفتوح ضخم (3.8M) — المصدر الأقل تنسيقًا
}

const GOOD_LICENSES = /\b(MIT|Apache[-\s]?2|BSD[-\s]?(2|3)|ISC|CC0|CC[-\s]BY(-\s?\d\.0)?|Unlicense|WTFPL|MSR)\b/i

/** بصمة محتوى المهارة — أساس كاش الثقة (تغيّر البصمة = إعادة فحص كامل) */
export function contentHashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32)
}

/** هل الكاش لسه صالح؟ (43.18: أي تغيير في المحتوى/الثقة/السياسة يلغي الكاش) */
export function trustCacheValid(storedHash: string, currentHash: string, storedStatus: string): boolean {
  return Boolean(storedHash) && storedHash === currentHash && storedStatus === "ACTIVE"
}

/**
 * بوابة الثقة الكاملة — تُستدعى عند: الاستيراد، والتفعيل (حتى لو الكاش — لو البصمة اتغيرت)،
 * وكل فحص inspect_skill. مفيش أي مهارة خارجية بتتفعّل من غير عدّها هنا.
 */
export function assessSkillTrust(input: SkillTrustInput): TrustResult {
  const checks: TrustCheck[] = []
  const reasons: string[] = []
  let score = 100
  let hardReject = false

  const full = `${input.name}\n${input.description}\n${input.body}`

  // 1) FORMAT VALIDATION — لازم شكل مهارة تعليمات فعلية
  const fmtOk =
    input.name.trim().length >= 3 &&
    (input.description.trim().length >= 15 || input.body.length >= 200) &&
    input.body.length >= 80 &&
    input.body.length <= 120_000 &&
    (input.body.match(/^#{1,4}\s|\n[-*]\s|\n\d+\.\s/gm) ?? []).length >= 2
  checks.push({ stage: "FORMAT", ok: fmtOk, penalty: fmtOk ? 0 : 45, detail: fmtOk ? "بنية تعليمات سليمة" : "ناقصة/فاضية/بلا بنية ماركداون" })
  if (!fmtOk) { score -= 45; reasons.push("الصيغة مش مهارة تعليمات سليمة") }

  // 2) SOURCE VALIDATION — خصم حسب نوع المصدر + كشف نطاقات شاككة في نص المهارة
  const srcPenalty = TRUSTED_SOURCE_KINDS[input.kind] ?? 10
  const shadySrc = /(pastebin\.com|anonfiles|drive\.google\.com\/uc)/i.test(full)
  checks.push({ stage: "SOURCE", ok: !shadySrc, penalty: srcPenalty + (shadySrc ? 25 : 0), detail: `${input.kind}:${input.sourceRef}` })
  score -= srcPenalty + (shadySrc ? 25 : 0)
  if (shadySrc) { hardReject = true; reasons.push("مصدر استضافة شاكك") }

  // 3) CONTENT VALIDATION — محتوى منطقي (مش سكريبت متنكر كتعليمات)
  const codeRatio = (full.match(/[{};()=<>]|=>|def |import |require\(/g) ?? []).length / Math.max(full.length, 1)
  const contentOk = codeRatio < 0.06 // تعليمات عادية فيها رموز قليلة — السكريبت الكثيف يرفض
  checks.push({ stage: "CONTENT", ok: contentOk, penalty: contentOk ? 0 : 40, detail: `كثافة رموز كود ${(codeRatio * 100).toFixed(1)}%` })
  if (!contentOk) { score -= 40; reasons.push("المحتوى شكله كود مش تعليمات") }

  // 4) LICENSE CHECK — الرخصة المعروفة والحرة تزيد الثقة؛ المجهولة خصم بسيط
  const lic = (input.license ?? "").trim()
  const licOk = !lic || GOOD_LICENSES.test(lic)
  const licPenalty = licOk ? (lic ? -5 : 6) : 20
  checks.push({ stage: "LICENSE", ok: licOk, penalty: licPenalty, detail: lic || "غير معلنة" })
  score -= licPenalty // سالب = مكافأة

  // 5) PROMPT-INJECTION CHECK — رفض صارم
  for (const [re, why] of INJECTION_PATTERNS) {
    if (re.test(full)) {
      checks.push({ stage: "INJECTION", ok: false, penalty: 100, detail: why })
      hardReject = true
      reasons.push(`حقن تعليمات: ${why}`)
      break
    }
  }
  if (!hardReject) checks.push({ stage: "INJECTION", ok: true, penalty: 0, detail: "نضيف" })

  // 6) TOOL PERMISSION CHECK — طلب أسرار/صلاحيات = رفض صارم
  for (const [re, why] of TOOL_PERM_PATTERNS) {
    if (re.test(full)) {
      checks.push({ stage: "TOOL_PERM", ok: false, penalty: 100, detail: why })
      hardReject = true
      reasons.push(`طلب صلاحيات ممنوعة: ${why}`)
      break
    }
  }
  if (!checks.some((c) => c.stage === "TOOL_PERM" && !c.ok)) checks.push({ stage: "TOOL_PERM", ok: true, penalty: 0, detail: "نضيف" })

  // 7) NETWORK ACTION CHECK — أفعال تسريب/إرسال = رفض صارم
  for (const [re, why] of NETWORK_PATTERNS) {
    if (re.test(full)) {
      checks.push({ stage: "NETWORK", ok: false, penalty: 100, detail: why })
      hardReject = true
      reasons.push(`فعل شبكي خطير: ${why}`)
      break
    }
  }
  if (!checks.some((c) => c.stage === "NETWORK" && !c.ok)) checks.push({ stage: "NETWORK", ok: true, penalty: 0, detail: "نضيف" })

  // 8) EXECUTION SAFETY CHECK — أي تنفيذ = رفض صارم (سياسة «تعليمات فقط»)
  for (const [re, why] of EXECUTION_PATTERNS) {
    if (re.test(full)) {
      checks.push({ stage: "EXECUTION", ok: false, penalty: 100, detail: why })
      hardReject = true
      reasons.push(`طلب تنفيذ: ${why}`)
      break
    }
  }
  // بيانات الاعتماد السحابية — نفس المعاملة القاسية (رفض قاطع)
  if (!checks.some((c) => c.stage === "EXECUTION" && !c.ok)) {
    for (const [re, why] of CLOUD_CRED_PATTERNS) {
      if (re.test(full)) {
        checks.push({ stage: "EXECUTION", ok: false, penalty: 100, detail: why })
        hardReject = true
        reasons.push(why)
        break
      }
    }
  }
  if (!checks.some((c) => c.stage === "EXECUTION" && !c.ok)) checks.push({ stage: "EXECUTION", ok: true, penalty: 0, detail: "نضيف" })

  score = Math.max(0, Math.min(100, score))
  const verdict: TrustVerdict = hardReject || score < 60 ? "FAIL" : "PASS"
  if (verdict === "FAIL" && !reasons.length) reasons.push(`الدرجة تحت الحد (${score} < 60)`)
  return { score, verdict, checks, hardReject, reasons }
}
