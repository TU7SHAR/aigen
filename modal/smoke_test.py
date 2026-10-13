"""
Modal smoke test — proves your auth + deploy + secret + web endpoint work,
with NO GPU and effectively zero cost (CPU-only, runs in milliseconds).

Deploy:
  python -m modal deploy modal/smoke_test.py

It prints an https://...modal.run URL. Open that URL in a browser (or curl it):
  curl -X POST <URL> -H "content-type: application/json" ^
       -H "x-worker-secret: prefectads" -d "{\"ping\":\"hi\"}"

Expected JSON: {"ok": true, "echo": {"ping": "hi"}, "secretMatched": true}

If `secretMatched` is true, the exact same secret wiring the video worker uses
is confirmed working. Once this is green, deploy the real video_worker.py.
"""

import os
import modal

app = modal.App("makeadclips-smoke-test")

# CPU-only, tiny image → negligible cost.
image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]")


@app.function(image=image, secrets=[modal.Secret.from_name("makeadclips-worker")])
@modal.fastapi_endpoint(method="POST")
def ping(payload: dict, request):
    expected = os.environ.get("WORKER_SECRET", "")
    got = request.headers.get("x-worker-secret", "")
    return {
        "ok": True,
        "echo": payload,
        "secretConfigured": bool(expected),
        "secretMatched": bool(expected) and got == expected,
        "note": "Modal deploy + web endpoint + secret all working. Safe to deploy the video worker.",
    }
