// LeadOS — عدّاد سريع لليدز في إنتاج Neon (للتشخيص فقط)
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'

const env = readFileSync('/home/z/my-project/.env.vercel-prod', 'utf-8')
const m = env.match(/^DATABASE_URL=(.+)$/m)
const url = m ? m[1].trim().replace(/^["']|["']$/g, '') : ''

const p = new PrismaClient({ datasources: { db: { url } } })

async function main() {
  const total = await p.lead.count()
  const ads = await p.lead.count({ where: { intentSignal: 'AD_SPENDER' } })
  const recentAds = await p.lead.findMany({
    where: { intentSignal: 'AD_SPENDER' },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { id: true, sourcePlatform: true, score: true, createdAt: true, business: { select: { name: true } } },
  })
  const last24 = await p.lead.count({ where: { createdAt: { gte: new Date(Date.now() - 864e5) } } })
  const jobs24 = await p.searchJob.count({ where: { createdAt: { gte: new Date(Date.now() - 864e5) } } })

  console.log(JSON.stringify({ total, ads, last24, jobs24, recentAds }, null, 1))
}

main()
  .then(() => p.$disconnect())
  .catch((e) => { require('fs').writeFileSync('/tmp/lead-err.txt', String(e)); process.exit(1) })
