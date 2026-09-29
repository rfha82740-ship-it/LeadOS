#!/usr/bin/env python3
"""إنشاء/تحديث GitHub Secret JINA_API_KEY على الريبو الجديد (SealedBox + public key)."""
import base64
import json
import urllib.request

import os
TOKEN = os.environ["GH_TOKEN"]
OWNER, REPO = "bdalhlymzaldyn7-ui", "LeadOS"
NAME = "JINA_API_KEY"
VALUE = os.environ["JINA_KEY"]

import nacl.public

def api(url, data=None, method=None):
    req = urllib.request.Request(url, method=method or ("PUT" if "/secrets/" in url and "/public-key" not in url else ("POST" if data else "GET")))
    req.add_header("Authorization", f"token {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    body = json.dumps(data).encode() if data else None
    with urllib.request.urlopen(req, body) as r:
        return json.load(r)

pk = api(f"https://api.github.com/repos/{OWNER}/{REPO}/actions/secrets/public-key")
key = nacl.public.PublicKey(base64.b64decode(pk["key"]))
sealed = nacl.public.SealedBox(key).encrypt(VALUE.encode())
api(f"https://api.github.com/repos/{OWNER}/{REPO}/actions/secrets/{NAME}", {
    "encrypted_value": base64.b64encode(sealed).decode(),
    "key_id": pk["key_id"],
})
print(f"secret {NAME} set ✓")
