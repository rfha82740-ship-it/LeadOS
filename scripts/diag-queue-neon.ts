// فحص مباشر: test-queue-stress على Neon (نفس استدعاء الـE2E) — تشخيص فشل db.workspace.findFirst
import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"

const db = readFileSync(".env.vercel-prod", "utf8").match(/DATABASE_URL="?(.+?)"?\s*$/m)![1]
console.log("DB URL shape:", db.slice(0, 24) + "...(" + db.length + " chars)")
try {
  const out = execSync("npx tsx scripts/test-queue-stress.ts", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: db },
    encoding: "utf8",
    timeout: 240_000,
  })
  console.log(out.split("\n").slice(-6).join("\n"))
} catch (e: unknown) {
  const err = e as { stdout?: string; stderr?: string; message?: string }
  console.log("STDOUT:", (err.stdout ?? "").slice(-600))
  console.log("STDERR:", (err.stderr ?? "").slice(-400))
}
