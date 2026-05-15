import hashlib
import json
import os
import sys


def process(data):
    url = data.get("url", "")
    risk = "low"

    if "phishing" in url:
        risk = "high"

    return {
        "risk": risk,
        "url": url
    }


def sha256_file(file_path):
    digest = hashlib.sha256()

    with open(file_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)

    return digest.hexdigest()


def verify_hashes(files):
    checked = []
    failures = []

    for item in files:
        file_path = os.path.abspath(item.get("path", ""))
        display_path = item.get("displayPath") or item.get("path")
        expected = str(item.get("sha256", "")).lower()
        optional = bool(item.get("optional"))

        if not os.path.exists(file_path):
            if optional:
                checked.append({
                    "path": display_path,
                    "status": "optional-missing"
                })
                continue

            failures.append({
                "path": display_path,
                "reason": "missing"
            })
            continue

        actual = sha256_file(file_path)

        if not expected or actual != expected:
            failures.append({
                "path": display_path,
                "reason": "hash-mismatch",
                "expected": expected,
                "actual": actual
            })
            continue

        checked.append({
            "path": display_path,
            "status": "ok"
        })

    return {
        "status": "valid" if not failures else "invalid",
        "checked": checked,
        "failures": failures
    }


def run_integrity_service():
    for line in sys.stdin:
        try:
            request = json.loads(line.strip())
            command = request.get("command")

            if command == "ping":
                print(json.dumps({
                    "status": "ok",
                    "service": "blackshield-integrity"
                }), flush=True)
                continue

            if command == "verify_hashes":
                print(json.dumps(verify_hashes(request.get("files", []))), flush=True)
                continue

            print(json.dumps({
                "status": "error",
                "failures": [{
                    "reason": "unknown command"
                }]
            }), flush=True)
        except Exception as exc:
            print(json.dumps({
                "status": "error",
                "failures": [{
                    "reason": str(exc)
                }]
            }), flush=True)


def run_url_engine():
    for line in sys.stdin:
        try:
            data = json.loads(line.strip())
            print(json.dumps(process(data)), flush=True)
        except Exception:
            pass


if __name__ == "__main__":
    if "--integrity-service" in sys.argv:
        run_integrity_service()
    else:
        run_url_engine()
