"""Generate approved fictional samples once. Never retry an uncertain submission."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request
import importlib.util

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("images", ROOT / "scripts/generate-ui-images.py")
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)
CONFIG = json.loads((ROOT / "src/data/sample-audio.json").read_text(encoding="utf-8"))
RECORDS = ROOT / ".data/ui-audio-jobs"
OUTPUT = ROOT / "public/media"


def generate():
    subscription = images.api("/v1/user/subscription")
    if subscription.get("max_credit_limit_extension") != 0:
        raise RuntimeError("Overages must remain disabled")
    if subscription.get("character_limit", 0) - subscription.get("character_count", 0) < 100_000:
        raise RuntimeError("Insufficient allowance safety margin")
    RECORDS.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for sample in CONFIG["samples"]:
        slug = sample["slug"]
        record_path = RECORDS / (slug + ".json")
        target = OUTPUT / (slug + ".mp3")
        if record_path.exists():
            prior = json.loads(record_path.read_text(encoding="utf-8"))
            if prior.get("status") == "completed" and target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == prior.get("sha256"):
                print(slug + ": already generated")
                continue
            raise RuntimeError("Existing audio submission needs reconciliation; no automatic retry")
        if target.exists():
            raise RuntimeError("Audio output already exists; refusing to overwrite")
        payload = {"text": sample["transcript"], "model_id": CONFIG["model_id"], "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}}
        request = urllib.request.Request("https://api.elevenlabs.io/v1/text-to-speech/" + CONFIG["voice_id"] + "?output_format=mp3_44100_128", data=json.dumps(payload).encode(), headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json", "Accept": "audio/mpeg"})
        record = {**sample, "provider": CONFIG["provider"], "model_id": CONFIG["model_id"], "voice_id": CONFIG["voice_id"], "voice_name": CONFIG["voice_name"], "status": "submitting"}
        with record_path.open("x", encoding="utf-8") as file:
            json.dump(record, file, indent=2)
        try:
            with images.OPENER.open(request, timeout=120) as response:
                if "audio/" not in response.headers.get("Content-Type", ""):
                    raise RuntimeError("Unexpected audio content type")
                data = response.read(15_000_001)
                request_id = response.headers.get("request-id", "")
            if not data or len(data) > 15_000_000 or not (data.startswith(b"ID3") or data[0] == 255 and data[1] & 224 == 224):
                raise RuntimeError("Invalid audio output")
            with target.open("xb") as file:
                file.write(data)
            record.update(status="completed", file="public/media/" + target.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), request_id=request_id)
        except Exception:
            record["status"] = "submission_unconfirmed"
            images.write_record(record_path, record)
            raise RuntimeError("Audio submission uncertain; reconcile before retrying. Provider details omitted.") from None
        images.write_record(record_path, record)
        print(slug + ": completed")
    records = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(RECORDS.glob("*.json"))]
    images.write_record(OUTPUT / "audio-provenance.json", {"assets": records})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate", action="store_true", required=True)
    parser.parse_args()
    try:
        generate()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "Audio generation failed; details omitted", file=sys.stderr)
        sys.exit(1)
