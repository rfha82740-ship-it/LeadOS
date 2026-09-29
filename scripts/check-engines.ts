// LeadOS — توزيع محركات البحث في العناصر الحديثة (اختبار Jina)
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'

const env = readFileSync('/home/z/my-project/.env.vercel-prod', 'utf-8')
const url = env.match(/^DATABASE_URL=(.+)$/m)![1].trim().replace(/^["']|["']$/g, '')
const p = new PrismaClient({ datasources: { db: { url } } })

async function main() {
  const since = new Date(Date.now() - 12 * 60000)
  const items = await p.contentItem.findMany({
    where: { collectedAt: { gte: since } },
    take: 400,
    select: { collectedAt: true, rawData: true },
  })
  const prov: Record<string, number> = {}
  for (const it of items) {
    const rd = (it.rawData ?? {}) as { provider?: string; adapter?: string }
    const k = rd.provider ?? rd.adapter ?? '-'
    prov[k] = (prov[k] ?? 0) + 1
  }
  console.log('ENGINES last 12m:', JSON.stringify(prov))
  const total = await p.lead.count()
  const ads = await p.lead.count({ where: { intentSignal: 'AD_SPENDER' } })
  const last30 = await p.lead.count({ where: { createdAt: { gte: new Date(Date.now() - 30 * 60000) } } })
  console.log('leads:', total, '| AD_SPENDER:', ads, '| last30m:', last30)
}

main()
  .then(() => p.$disconnect())
  .catch((e) => { console.error(String(e).slice(0, 200)); process.exit(1) })
