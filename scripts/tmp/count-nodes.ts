// LeadOS — تشخيص: عدّ عقد أحدث خريطة
import { PrismaClient } from "@prisma/client"
async function main() {
  const db = new PrismaClient()
  const g = await db.taskGraph.findFirst({ orderBy: { createdAt: "desc" } })
  if (!g) return console.log("لا خرايط")
  const nodes = await db.taskGraphNode.findMany({ where: { graphId: g.id }, select: { nodeId: true, type: true, status: true } })
  console.log("أحدث خريطة:", g.id.slice(0, 8), g.status, "| nodes:", nodes.length)
  console.log(nodes.map(n => `${n.nodeId}:${n.type}:${n.status}`).join(" "))
  await db.$disconnect()
}
main()
