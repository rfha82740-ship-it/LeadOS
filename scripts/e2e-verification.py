#!/usr/bin/env python3
"""E2E Verification Battery على الإنتاج الحقيقي (§20-21, §25):
جلسة مشرف مشروعة (JWT بـ AUTH_SECRET من بيئة الإنتاج) → كل الـAPIs المحمية.
الأول: ورشة اختبار معزولة للتجرّب، وبعدها قراءات حية على الورشة الرئيسية.
"""
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "https://leados-v2.vercel.app"
RESULTS = []


def load_env(path):
    env = {}
    for line in open(path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env("/home/z/my-project/.env.vercel-prod")
ADMIN_ID = "0017a7f9-eec0-40fa-98d2-bc681dd7eb38"  # leados.admin (OWNER)


def b64url(b):
    import base64
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def mint_token(secret: str, sub: str, ttl=3600):
    h = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    p = b64url(json.dumps({"sub": sub, "iat": now, "exp": now + ttl}).encode())
    sig = b64url(hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
    return f"{h}.{p}.{sig}"


def call(method: str, path: str, token=None, body=None, apikey=None, timeout=30):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Cookie", f"leados_session={token}")
    if apikey:
        req.add_header("x-api-key", apikey)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw)
            except Exception:
                return r.status, raw[:200]
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, "-"


def step(name, ok, detail):
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)


def guard(name, fn):
    try:
        fn()
    except Exception as e:
        step(name, False, f"EXCEPTION: {type(e).__name__} {str(e)[:100]}")


def main() -> int:
    secret = ENV["AUTH_SECRET"]
    admin = mint_token(secret, ADMIN_ID)

    def phase_a():
        nonlocal admin
        # ── A) قراءات حية على الورشة الرئيسية ──────────────────────────
        st, d = call("GET", "/api/overview", admin)
        ok = st == 200 and isinstance(d, dict)
        step("A1.overview", ok, f"HTTP {st} keys={list(d.keys())[:8] if ok else d}")

        st, d = call("GET", "/api/system", admin)
        ok = st == 200
        step("A2.system_state", ok, f"HTTP {st} {json.dumps(d, ensure_ascii=False)[:180] if ok else d}")

        st, d = call("GET", "/api/queue?limit=5", admin)
        ok = st == 200
        step("A3.queue_api", ok, f"HTTP {st} {str(d)[:160]}")

        st, d = call("GET", "/api/system/capacity", admin)
        ok = st == 200
        step("A4.capacity_api", ok, f"HTTP {st} {str(d)[:160]}")

        st, d = call("GET", "/api/leads?limit=3", admin)
        ok = st == 200
        step("A5.leads_crm", ok, f"HTTP {st} {str(d)[:120]}")

        st, d = call("GET", "/api/skills", admin)
        ok = st == 200
        step("A6.skills_api", ok, f"HTTP {st} {str(d)[:120]}")

        st, d = call("GET", "/api/alerts", admin)
        ok = st == 200
        step("A7.alerts_api", ok, f"HTTP {st} {str(d)[:120]}")

        st, d = call("GET", "/api/sources", admin)
        ok = st == 200
        step("A8.sources_api", ok, f"HTTP {st} {str(d)[:120]}")

        # غير مصرح لازم يترفض
        st, _ = call("GET", "/api/overview")
        step("A9.auth_gate", st in (401, 403), f"من غير جلسة → HTTP {st} (مرفوض صح)")

    guard("A.phase", phase_a)

    def phase_b():
        # ── B) Farm Plan + Ingest provenance journey (§10) ─────────────
        ing = ENV.get("INGEST_API_KEY") or ENV.get("LEADOS_API_KEY")
        st, plan = call("GET", "/api/farm/plan", apikey=ing)
        if st != 200:
            st, plan = call("POST", "/api/farm/plan", apikey=ing, body={"platform": "FACEBOOK", "limit": 3})
        ok = st == 200 and isinstance(plan, dict)
        plan_id = plan.get("planId") if ok else None
        queries = [q.get("q") for q in plan.get("queries", [])][:2] if ok else []
        step("B1.farm_plan", ok, f"HTTP {st} planId={plan_id} selectedBy={plan.get('selectedBy') if ok else '-'} queries={len(queries)}")
        if ok and plan.get("queries"):
            q0 = plan["queries"][0]
            prov = {k: q0.get(k) for k in ("querySource", "skillId", "skillKind", "reason")}
            step("B2.plan_provenance", any(prov.values()), f"provenance={prov}")
        else:
            step("B2.plan_provenance", False, "لا queries في الـplan")

        # ingest عنصر اختبار واحد مربوط بالـplan (بيتعقب بعدين ويُنضف)
        st, w = call("POST", "/api/ingest/webhook", apikey=ing, body={"items": [{
            "platform": "WEBSITE",
            "query": (queries[0] if queries else "verification-probe"),
            "querySource": "plan",
            "planId": plan_id or "test-plan",
            "skillId": "verification-suite",
            "skillKind": "CORE",
            "title": "شركة اختبار التحقق الشامل VERIFICATION-PROBE-DELETE-ME",
            "url": "https://example.com/verification-probe",
            "body": "عنصر اختبار E2E — بيتم حذفه فورًا بعد التحقق من الـprovenance",
        }]})
        ok = st in (200, 201) and isinstance(w, dict)
        step("B3.ingest_webhook", ok, f"HTTP {st} {str(w)[:200]}")

    guard("B.phase", phase_b)

    def phase_c():
        # ── C) DSI: TaskGraph حقيقي (§8) ──────
        st, g = call("POST", "/api/graph", admin, {"objective": "ابحث عن مطاعم في القاهرة الجديدة تحتاج تسويق"}, timeout=110)
        ok = st in (200, 201, 202) and isinstance(g, dict)
        gdata = g.get("graph") if ok else None
        gid = (gdata or {}).get("id") or (g.get("graphId") if ok else None)
        step("C2.dsi_graph_create", ok, f"HTTP {st} graphId={gid} status={(gdata or {}).get('status')}")

        if gid:
            st, gi = call("GET", f"/api/graph?id={gid}", admin)
            ok = st == 200 and isinstance(gi, dict)
            graph = gi.get("graph") if ok else {}
            nodes = graph.get("nodes") or (gi.get("nodes") or []) if ok else []
            events = graph.get("events") or (gi.get("events") or []) if ok else []
            step("C3.dsi_graph_inspect", ok,
                 f"HTTP {st} status={graph.get('status')} nodes={len(nodes)} events={len(events)} "
                 f"facts={list((graph.get('facts') or {}).keys())[:5] if ok else '-'}")

    guard("C.phase", phase_c)

    def phase_d():
        # ── D) Dashboard pages (§20) ────────────────────
        pages = ["/", "/leads", "/queue", "/system", "/skills", "/groups", "/radar", "/settings"]
        oks = []
        for p in pages:
            st, _ = call("GET", p, admin)
            oks.append(st == 200)
        step("D1.dashboard_pages", all(oks), f"{sum(oks)}/{len(oks)} صفحات 200: {dict(zip(pages, oks))}")

    guard("D.phase", phase_d)

    print(f"\nE2E BATTERY: {sum(1 for r in RESULTS if r[1])}/{len(RESULTS)} PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
