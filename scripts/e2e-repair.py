#!/usr/bin/env python3
"""إعادة الأجزاء الفاشلة من البطارية بعد تصحيح العقود."""
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request

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
ADMIN_ID = "0017a7f9-eec0-40fa-98d2-bc681dd7eb38"


def b64url(b):
    import base64
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def mint_token(secret, sub, ttl=3600):
    h = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    p = b64url(json.dumps({"sub": sub, "iat": now, "exp": now + ttl}).encode())
    sig = b64url(hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
    return f"{h}.{p}.{sig}"


def call(method, path, token=None, body=None, apikey=None, timeout=40):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
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


def main() -> int:
    admin = mint_token(ENV["AUTH_SECRET"], ADMIN_ID)
    ing = ENV.get("INGEST_API_KEY") or ENV.get("LEADOS_API_KEY")

    # A2 صح: حالة النظام من /api/system/stop GET
    st, d = call("GET", "/api/system/stop", admin)
    ok = st == 200
    step("A2.system_state", ok, f"HTTP {st} {json.dumps(d, ensure_ascii=False)[:200] if ok else d}")

    # B1 صح: GET مع platform
    st, plan = call("GET", "/api/farm/plan?platform=FACEBOOK", apikey=ing)
    ok = st == 200 and isinstance(plan, dict)
    plan_id = plan.get("planId") if ok else None
    queries = plan.get("queries", []) if ok else []
    step("B1.farm_plan", ok, f"HTTP {st} planId={plan_id} selectedBy={plan.get('selectedBy') if ok else '-'} queries={len(queries)}")
    if ok and queries:
        q0 = queries[0]
        prov = {k: q0.get(k) for k in ("querySource", "skillId", "skillKind", "reason")}
        step("B2.plan_provenance", any(prov.values()), f"provenance={prov} q={q0.get('q', '')[:50]}")

    # B3 صح: name مطلوب
    st, w = call("POST", "/api/ingest/webhook", apikey=ing, body={"source": "Verification-Suite", "items": [{
        "name": "شركة اختبار التحقق الشامل VERIFICATION-PROBE-DELETE-ME",
        "url": "https://example.com/verification-probe-e2e",
        "body": "عنصر اختبار E2E — provenance journey",
        "query": (queries[0].get("q") if queries else "verification-probe"),
        "querySource": "plan",
        "planId": plan_id or "test-plan",
        "skillId": "verification-suite",
        "skillKind": "CORE",
    }]})
    ok = st in (200, 201) and isinstance(w, dict)
    detail = f"HTTP {st} {json.dumps(w, ensure_ascii=False)[:260]}" if ok else f"HTTP {st} {str(w)[:200]}"
    step("B3.ingest_webhook", ok, detail)

    # B4: اتتبع العنصر في الداتابيز بالـprovenance (هعمله في سكريبت منفصل على الدايركت)

    print(f"\nREPAIR BATTERY: {sum(1 for r in RESULTS if r[1])}/{len(RESULTS)} PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
