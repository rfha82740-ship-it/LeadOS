#!/usr/bin/env python3
"""اختبار الطابور الذري على Neon الحقيقي (§7): claim متزامن، requeue للمعطل، retry/backoff."""
import json
import sys
import threading
import uuid

import psycopg

DATABASE_URL = None
for line in open("/home/z/my-project/scripts/deploy/.tokens"):
    line = line.strip()
    if line.startswith("DATABASE_URL="):
        DATABASE_URL = line.split("=", 1)[1].strip().strip('"').strip("'")
if not DATABASE_URL:
    raise SystemExit("no DATABASE_URL in .tokens")

results = []


def step(name: str, ok: bool, detail: str):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)


def main() -> int:
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute('SELECT id FROM "Workspace" ORDER BY "createdAt" LIMIT 1')
        ws = cur.fetchone()[0]
        jid = f"test_{uuid.uuid4().hex[:12]}"

        # 1) CREATE
        cur.execute(
            'INSERT INTO "Job" (id, "workspaceId", type, status, priority, attempts, "maxAttempts", payload, "scheduledAt", "createdAt", "updatedAt")'
            " VALUES (%s, %s, 'CLEANUP', 'QUEUED', 99, 0, 5, %s, now() - interval '1 minute', now(), now())",
            (jid, ws, json.dumps({"test": "atomic-claim-verification"})),
        )
        step("1.create_job", True, f"Job {jid} QUEUED (CLEANUP, test payload)")

        # 2) CONCURRENT CLAIM — نفس نمط claimJobs: UPDATE ... WHERE status IN (QUEUED,RETRYING)
        winners = []
        lock = threading.Lock()

        def claim(worker: str):
            try:
                with psycopg.connect(DATABASE_URL, autocommit=True) as c2:
                    with c2.cursor() as c:
                        c.execute(
                            'UPDATE "Job" SET status = \'RUNNING\', "lockedAt" = now(), "workerId" = %s, attempts = attempts + 1'
                            " WHERE id = %s AND status IN ('QUEUED','RETRYING')",
                            (worker, jid),
                        )
                        with lock:
                            winners.append((worker, c.rowcount))
            except Exception as e:
                with lock:
                    winners.append((worker, -1, str(e)))

        threads = [
            threading.Thread(target=claim, args=(f"worker-A-{uuid.uuid4().hex[:4]}",)),
            threading.Thread(target=claim, args=(f"worker-B-{uuid.uuid4().hex[:4]}",)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        total_won = sum(w[1] for w in winners if w[1] > 0)
        step("2.atomic_claim_x2", total_won == 1, f"2 claims متزامنين → {total_won} فائز (قاعدة واحد بس)")

        # 3) STALE REQUEUE
        cur.execute('UPDATE "Job" SET "lockedAt" = now() - interval \'20 minutes\' WHERE id = %s', (jid,))
        cur.execute(
            'UPDATE "Job" SET status = \'QUEUED\', "workerId" = NULL, "lockedAt" = NULL'
            " WHERE id = %s AND status = 'RUNNING' AND \"lockedAt\" < now() - interval '10 minutes'",
            (jid,),
        )
        cur.execute('SELECT status FROM "Job" WHERE id = %s', (jid,))
        st3 = cur.fetchone()[0]
        step("3.stale_requeue", st3 == "QUEUED", f"قفل عمره 20 دقيقة → SQL الـstale → status={st3}")

        # 4) RETRY/BACKOFF → FAILED عند maxAttempts
        seen = []
        for i in range(1, 6):
            cur.execute('UPDATE "Job" SET status = \'RUNNING\' WHERE id = %s', (jid,))
            cur.execute(
                'UPDATE "Job" SET attempts = %s, status = (CASE WHEN %s >= "maxAttempts" THEN \'FAILED\' ELSE \'RETRYING\' END)::"JobStatus",'
                " \"scheduledAt\" = now() + interval '1 second' * LEAST(600, 60 * POWER(2, %s))"
                " WHERE id = %s RETURNING status",
                (i, i, i, jid),
            )
            seen.append(cur.fetchone()[0])
        step("4.retry_backoff_max", seen[-1] == "FAILED" and "RETRYING" in seen,
             f"المحاولات 1..5 → {seen} (backoff أُسّي بحد 600ث، FAILED عند maxAttempts)")

        # 5) فحص stale على الإنتاج
        cur.execute("SELECT count(*) FROM \"Job\" WHERE status = 'RUNNING' AND \"lockedAt\" < now() - interval '15 minutes'")
        stale_prod = cur.fetchone()[0]
        step("5.prod_stale_check", stale_prod == 0, f"صفوف RUNNING معلقة في الإنتاج = {stale_prod}")

        # تنظيف
        cur.execute('DELETE FROM "Job" WHERE id = %s', (jid,))
        step("6.cleanup", cur.rowcount == 1, "صف الاختبار اتحذف — الإنتاج كما كان")

    fails = [r for r in results if not r[1]]
    print(f"\nQUEUE TEST: {len(results) - len(fails)}/{len(results)} PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
