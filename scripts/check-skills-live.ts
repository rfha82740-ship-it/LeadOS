// LeadOS — فحص نظام الاسكلز الحي (مين بيقود الاختيار ومين متعلّم)
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'

const env = readFileSync('/home/z/my-project/.env.vercel-prod', 'utf-8')
const url = env.match(/^DATABASE_URL=(.+)$/m)![1].trim().replace(/^["']|["']$/g, '')
const p = new PrismaClient({ datasources: { db: { url } } })

async function main() {
  // آخر جوبات: هل عليها اسكلز ومين المختار
  const jobs = await p.searchJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: 6,
    select: { id: true, status: true, metadata: true, createdAt: true },
  })
  for (const j of jobs) {
    const meta = (j.metadata ?? {}) as { skills?: Array<{ skill?: string; platform?: string }>; queries?: string[]; selectedBy?: string }
    const skills = (meta.skills ?? []).map((s) => `${s.platform ?? '?'}:${s.skill ?? '?'}`).slice(0, 4)
    console.log(`${j.createdAt.toISOString().slice(11, 19)} | ${j.status} | selectedBy=${meta.selectedBy ?? '-'} | skills=[${skills.join(', ')}]`)
  }
  // مكتبة GitSkills العالمية
  const gitSkills = await p.gitSkill.count()
  const lastHarvest = await p.gitSkill.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
  console.log('GitSkill مكتبة:', gitSkills, '| آخر حصاد:', lastHarvest?.createdAt?.toISOString?.() ?? '-')
  // توزيع الليدز الأخيرة على المصادر
  const since = new Date(Date.now() - 30 * 60000)
  const byPlatform = await p.lead.groupBy({
    by: ['sourcePlatform'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  })
  console.log('ليدز آخر 30 دقيقة بالمصدر:', byPlatform.map((g) => `${g.sourcePlatform}:${g._count._all}`).join(' | '))
}

main()
  .then(() => p.$disconnect())
  .catch((e) => { require('fs').writeFileSync('/tmp/skills-err.txt', String(e)); process.exit(1) })
