// مقارنة هيدرز Node fetch ضد فيسبوك — عشان نعرف إيه اللي بيرجع 400
import fs from "fs"

const cookie = fs
  .readFileSync("/home/z/my-project/.env.local", "utf8")
  .split("\n")
  .find((l) => l.startsWith("FACEBOOK_SESSION_COOKIE="))!
  .split("=")
  .slice(1)
  .join("=")
const FB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const gid = "1616147968808747"

async function t(name: string, headers: Record<string, string>) {
  try {
    const r = await fetch(`https://www.facebook.com/groups/${gid}/posts/`, { headers, redirect: "follow" })
    const h = await r.text()
    const stories = (h.match(/"__typename":"Story"/g) || []).length
    console.log(`${name}: HTTP ${r.status} | Stories: ${stories} | حجم: ${Math.round(h.length / 1024)}KB`)
  } catch (e) {
    console.log(`${name}: ERR ${(e as Error).message.slice(0, 80)}`)
  }
}

async function main() {
  // زي الإنتاج حرفيًا
  await t("زي-الإنتاج", {
    Cookie: cookie,
    "User-Agent": FB_UA,
    "Accept-Language": "ar,eg;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Sec-Fetch-Mode": "navigate",
  })
  // + هيدرز متصفح كاملة
  await t("كامل", {
    Cookie: cookie,
    "User-Agent": FB_UA,
    "Accept-Language": "ar,eg;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  })
  // من غير Sec-Fetch خالص (زي urllib اللي نجح)
  await t("بدون-secfetch", {
    Cookie: cookie,
    "User-Agent": FB_UA,
    "Accept-Language": "ar,eg;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  })
}

main()
