"""Generate the three approved UI assets; credentials come only from the environment.

Create one job: python scripts/generate-ui-images.py --create admissions-recovery
Collect jobs:  python scripts/generate-ui-images.py --collect
POST requests are never retried automatically. Existing job records prevent duplicates.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "scripts/ui-image-prompts.json").read_text(encoding="utf-8"))
RECORDS = ROOT / ".data/ui-image-jobs"
OUTPUT = ROOT / "public/media"
API = "https://api.elevenlabs.io"
LIMIT = 25 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def api(path, payload=None):
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")
    request = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with OPENER.open(request, timeout=90) as response:
            return json.loads(response.read(2_000_000))
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read(10000)).get("detail", {})
            message = detail.get("message", "") if isinstance(detail, dict) else ""
            message = re.sub(r"https?://\S+", "[URL omitted]", str(message).replace(key, "[redacted]"))
            message = re.sub(r"[\x00-\x1f\x7f]", " ", message)[:500]
        except Exception:
            message = "Response details omitted"
        raise RuntimeError(f"ElevenLabs HTTP {error.code}: {message}") from None
    except Exception:
        raise RuntimeError("API request failed; do not retry a POST without reconciling its job") from None


def write_record(path, record):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def create(slug):
    asset = next(item for item in CONFIG["assets"] if item["slug"] == slug)
    RECORDS.mkdir(parents=True, exist_ok=True)
    path = RECORDS / f"{slug}.json"
    if path.exists():
        raise RuntimeError("Job record already exists; collect or reconcile it instead of regenerating")
    subscription = api("/v1/user/subscription")
    if subscription.get("max_credit_limit_extension") != 0:
        raise RuntimeError("Usage-based overages are not disabled; obtain explicit spending approval")
    if subscription.get("character_limit", 0) - subscription.get("character_count", 0) < 100_000:
        raise RuntimeError("Insufficient safety margin in included allowance; review before generation")
    payload = {key: CONFIG[key] for key in ("model_id", "quality", "resolution")}
    payload.update(aspect_ratio=asset["aspect_ratio"], prompt=CONFIG["style"] + "\n\n" + asset["prompt"])
    record = {"slug": slug, "provider": "ElevenLabs", "request": payload,
              "alt": asset["alt"], "placement": asset["placement"],
              "created_at": datetime.now(timezone.utc).isoformat(), "status": "submitting"}
    # Exclusive creation also guards against concurrent or accidental duplicate requests.
    with path.open("x", encoding="utf-8") as file:
        json.dump(record, file, indent=2)
    try:
        result = api("/v1/flows/image", payload)
        generation_id = result.get("id", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", generation_id):
            raise RuntimeError("Unexpected generation ID; reconcile before retrying")
        record.update(generation_id=generation_id, status=result["status"])
    except RuntimeError:
        record["status"] = "submission_unconfirmed"
        write_record(path, record)
        raise
    write_record(path, record)
    print(slug + ": " + record["status"] + " (job recorded)")


def download(url):
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port
            or not (host == "storage.googleapis.com" or host.endswith(".googleapis.com")
                    or host.endswith(".elevenlabs.io") or host.endswith(".amazonaws.com"))):
        raise RuntimeError("Unrecognized asset host; review privately before downloading")
    try:
        # Do not forward API authorization to the signed asset URL.
        with OPENER.open(urllib.request.Request(url), timeout=90) as response:
            data = response.read(LIMIT + 1)
        if len(data) > LIMIT or not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("Asset is oversized or not a PNG")
        return data
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError("Asset download failed; signed URL omitted") from None


def collect():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for path in sorted(RECORDS.glob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if not record.get("generation_id"):
            print(record["slug"] + ": needs submission reconciliation")
            continue
        target = OUTPUT / (record["slug"] + ".png")
        if record.get("sha256") and target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() != record["sha256"]:
                raise RuntimeError("Local asset changed; refusing to overwrite")
            print(record["slug"] + ": already downloaded")
            continue
        result = api("/v1/flows/image/" + record["generation_id"])
        record["status"] = result["status"]
        if result["status"] == "completed":
            if result.get("content_mime_type") != "image/png":
                raise RuntimeError("Unexpected media type; output not downloaded")
            data = download(result["content_url"])
            with target.open("xb") as file:
                file.write(data)
            record.update(file="public/media/" + target.name, bytes=len(data),
                          sha256=hashlib.sha256(data).hexdigest())
        elif result["status"] == "failed":
            record["failure_reason"] = result.get("failure_reason", "unknown")
        write_record(path, record)
        print(record["slug"] + ": " + record["status"])
    manifest_path = OUTPUT / "image-provenance.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"assets": []}
    previous_assets = {asset["slug"]: asset for asset in previous["assets"]}
    manifest = []
    for path in sorted(RECORDS.glob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        prior = previous_assets.get(record["slug"], {})
        if prior.get("sha256") and prior["sha256"] == record.get("sha256"):
            record = {**prior, **record}
        manifest.append(record)
    write_record(manifest_path, {"assets": manifest})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--create", choices=[item["slug"] for item in CONFIG["assets"]])
    group.add_argument("--collect", action="store_true")
    args = parser.parse_args()
    if args.create:
        create(args.create)
    else:
        collect()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, StopIteration) as error:
        print(str(error) if isinstance(error, RuntimeError) else "Local processing failed; details omitted", file=sys.stderr)
        sys.exit(1)
