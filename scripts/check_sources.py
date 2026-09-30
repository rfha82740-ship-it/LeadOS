#!/usr/bin/env python3
"""Live-test every provider behind LeadOS's 16 hunting sources.

Reads real keys from .env.vercel-prod. NEVER prints key values.
Distinguishes: OK / AUTH_FAIL / QUOTA / NET_BLOCKED (sandbox) / ERROR.
"""
import json
import re
import ssl
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path("/home/z/my-project")
ENVF = ROOT / ".env.vercel-prod"


def env(key: str) -> str:
    m = re.search(rf'^{key}\s*=\s*"?([^"\n]+)"?', ENVF.read_text(), re.M)
    return m.group(1).strip() if m else ""


def mask(v: str) -> str:
    return f"{v[:4]}…{v[-3:]} ({len(v)})" if v else "MISSING"


def call(name: str, url: str, headers=None, data=None, method=None, check=None):
    """Run one provider probe; classify outcome. check(body,status)->verdict str"""
    try:
        req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace")[:4000]
            verdict = check(body, r.status) if check else f"OK (HTTP {r.status})"
            return name, verdict
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        low = body.lower()
        if e.code in (401, 403):
            v = f"AUTH_FAIL (HTTP {e.code})"
        elif e.code == 429:
            v = f"QUOTA/RATE_LIMIT (HTTP 429)"
        elif "credit" in low or "quota" in low or "balance" in low or "insufficient" in low:
            v = f"QUOTA (HTTP {e.code})"
        else:
            v = f"ERROR (HTTP {e.code}: {body[:80]})"
        return name, v
    except (urllib.error.URLError, ssl.SSLError, OSError) as e:
        msg = str(e.reason) if hasattr(e, "reason") else str(e)
        if "Name or service not known" in msg or "getaddrinfo" in msg or "resolve" in msg.lower():
            return name, "NET_BLOCKED_FROM_SANDBOX (DNS)"
        return name, f"NET_ERROR ({msg[:80]})"


results = []

# ---- SEARCH PROVIDERS ----
k = env("SERPER_API_KEY")
results.append(call(
    "serper (google search/places)",
    "https://google.serper.dev/search",
    headers={"X-API-KEY": k, "Content-Type": "application/json"},
    data=json.dumps({"q": "plumber cairo", "num": 3}).encode(),
    method="POST",
    check=lambda b, s: f"OK — {min(len(re.findall(chr(39)+'\"position\"'+chr(39)+chr(44)+' '+chr(39)+chr(39)), b)), 3} organic results (HTTP {s})" if '"organic"' in b else f"HTTP {s} — unexpected body",
))

k = env("TAVILY_API_KEY")
results.append(call(
    "tavily (web fallback)",
    "https://api.tavily.com/search",
    headers={"Content-Type": "application/json"},
    data=json.dumps({"api_key": k, "query": "restaurant giza", "max_results": 2}).encode(),
    method="POST",
    check=lambda b, s: f"OK — {b.count('\"url\"')} results (HTTP {s})" if '"results"' in b else f"HTTP {s} unexpected",
))

k = env("SERPAPI_API_KEY")
results.append(call(
    "serpapi (web fallback)",
    "https://serpapi.com/search?api_key=" + k + "&q=cafe+cairo&num=3",
    check=lambda b, s: f"OK — organic_results present (HTTP {s})" if '"organic_results"' in b else f"HTTP {s} unexpected",
))

k = env("EXA_API_KEY")
results.append(call(
    "exa (semantic fallback)",
    "https://api.exa.ai/search",
    headers={"x-api-key": k, "Content-Type": "application/json"},
    data=json.dumps({"query": "dentist alexandria", "numResults": 2}).encode(),
    method="POST",
    check=lambda b, s: f"OK — {b.count('\"id\"')} results (HTTP {s})" if '"results"' in b else f"HTTP {s} unexpected",
))

k = env("JINA_API_KEY")
results.append(call(
    "jina reader (page reading)",
    "https://r.jina.ai/https://example.com",
    headers={"Authorization": f"Bearer {k}"},
    check=lambda b, s: f"OK — {len(b)} bytes read (HTTP {s})" if len(b) > 50 else f"HTTP {s} empty",
))

k = env("ZENROWS_API_KEYS")
first = k.split(",")[0].strip() if k else ""
results.append(call(
    "zenrows (bing scraping)",
    "https://api.zenrows.com/v1/?apikey=" + first + "&url=https%3A%2F%2Fwww.bing.com%2Fsearch%3Fq%3Dtest",
    check=lambda b, s: f"OK — {len(b)} bytes html (HTTP {s})" if len(b) > 200 else f"HTTP {s} short body",
))

# ---- AI PROVIDERS (تحليل/بحث ذكي — بتخدم كل المصادر) ----
k = env("GEMINI_API_KEY")
results.append(call(
    "gemini (ai analysis)",
    f"https://generativelanguage.googleapis.com/v1beta/models?key={k}",
    check=lambda b, s: f"OK — models listed (HTTP {s})" if '"models"' in b else f"HTTP {s} unexpected",
))

k = env("MISTRAL_API_KEY") or env("MISTRAL_API_KEYS").split(",")[0].strip()
results.append(call(
    "mistral (ai analysis)",
    "https://api.mistral.ai/v1/models",
    headers={"Authorization": f"Bearer {k}"},
    check=lambda b, s: f"OK — {b.count(chr(34)+'id'+chr(34))} models (HTTP {s})" if '"data"' in b else f"HTTP {s} unexpected",
))

k = env("NVIDIA_API_KEY")
results.append(call(
    "nvidia (ai analysis)",
    "https://integrate.api.nvidia.com/v1/models",
    headers={"Authorization": f"Bearer {k}"},
    check=lambda b, s: f"OK — models listed (HTTP {s})" if '"data"' in b else f"HTTP {s} unexpected",
))

k = env("DAHL_API_KEY")
base = env("DAHL_BASE_URL") or "https://inference.dahl.global/v1"
results.append(call(
    "dahl (ai inference)",
    f"{base}/models",
    headers={"Authorization": f"Bearer {k}"},
    check=lambda b, s: f"OK — models listed (HTTP {s})" if '"data"' in b or '"id"' in b else f"HTTP {s} unexpected",
))

# ---- FACEBOOK SESSION (بيخدم فيسبوك + جروبات فيسبوك + مكتبة الإعلانات) ----
ck = env("FACEBOOK_SESSION_COOKIE")
if ck:
    results.append(call(
        "facebook session cookie",
        "https://www.facebook.com/me",
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Cookie": ck},
        check=lambda b, s: f"SESSION ALIVE (HTTP {s}, profile page)" if s == 200 and ("c_user" not in b and "login" not in b.lower()[:600]) else (f"SESSION DEAD — redirected to login (HTTP {s})" if s in (200, 302) else f"HTTP {s}"),
    ))
else:
    results.append(("facebook session cookie", "MISSING KEY"))

print(f"{'PROVIDER':<38} {'VERDICT'}")
print("=" * 90)
ok = 0
for name, verdict in results:
    print(f"{name:<38} {verdict}")
    if verdict.startswith("OK") or "ALIVE" in verdict:
        ok += 1
print("=" * 90)
print(f"LIVE OK: {ok}/{len(results)} providers")
