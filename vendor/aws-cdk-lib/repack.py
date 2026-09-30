#!/usr/bin/env python3
"""Reproduce CDK 2.269.0 with the upstream brace-expansion 5.0.12 bundle."""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import time
import urllib.request


PACKAGES = {
    "aws-cdk-lib-2.269.0.tgz": (
        "https://registry.npmjs.org/aws-cdk-lib/-/aws-cdk-lib-2.269.0.tgz",
        "Ob2EmB3faXGUMjXYhxsMvktZtaojr/aaeLqFjq9WbO+vOX1mx49OQPVB6NNNLfNKWF993Bb6nr4rsPblpUAJww==",
    ),
    "brace-expansion-5.0.12.tgz": (
        "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz",
        "YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==",
    ),
}
PREFIX = "package/node_modules/brace-expansion/"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch(name, cache):
    url, expected = PACKAGES[name]
    destination = cache / name
    if destination.exists():
        data = destination.read_bytes()
    else:
        deadline = time.monotonic() + 120
        chunks = []
        with urllib.request.urlopen(url, timeout=20) as response:
            while chunk := response.read(1024 * 1024):
                if time.monotonic() > deadline:
                    raise TimeoutError(f"Download deadline exceeded: {name}")
                chunks.append(chunk)
        data = b"".join(chunks)
    actual = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != expected:
        raise ValueError(f"Upstream integrity mismatch: {name}")
    if not destination.exists():
        destination.write_bytes(data)
    return data


def entries(data):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            if member.isdir():
                continue
            if not member.isfile() or not member.name.startswith("package/"):
                raise ValueError(f"Unexpected archive member: {member.name}")
            if ".." in Path(member.name).parts or member.name in result:
                raise ValueError(f"Unsafe or duplicate archive member: {member.name}")
            result[member.name] = (archive.extractfile(member).read(), member.mode & 0o777)
    return result


def repack(original, replacement):
    patched = {name: value for name, value in original.items() if not name.startswith(PREFIX)}
    patched.update({PREFIX + name.removeprefix("package/"): value for name, value in replacement.items()})
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, (data, mode) in sorted(patched.items()):
                member = tarfile.TarInfo(name)
                member.size = len(data)
                member.mode = mode
                member.mtime = 0
                archive.addfile(member, io.BytesIO(data))
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check", action="store_true", help="Compare against an existing output instead of writing it.")
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    original_bytes, replacement_bytes = [fetch(name, args.cache_dir) for name in PACKAGES]
    original, replacement = entries(original_bytes), entries(replacement_bytes)
    result = repack(original, replacement)
    actual = entries(result)
    untouched = {name: value for name, value in original.items() if not name.startswith(PREFIX)}
    if not all(actual[name] == value for name, value in untouched.items()):
        raise ValueError("CDK content changed")
    expected_replacement = {
        name.removeprefix("package/"): value for name, value in replacement.items()
    }
    if {name.removeprefix(PREFIX): value for name, value in actual.items() if name.startswith(PREFIX)} != expected_replacement:
        raise ValueError("Replacement differs from upstream")
    if json.loads(actual["package/package.json"][0])["version"] != "2.269.0":
        raise ValueError("Unexpected CDK version")
    if json.loads(actual[PREFIX + "package.json"][0])["version"] != "5.0.12":
        raise ValueError("Unexpected replacement version")
    if args.check:
        if args.output.read_bytes() != result:
            raise ValueError("Vendored archive differs from the reproduced bytes")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(result)
    report = {
        "cdkVersion": "2.269.0",
        "replacementVersion": "5.0.12",
        "upstreamArchives": {
            name: {"url": PACKAGES[name][0], "sha512": "sha512-" + PACKAGES[name][1], "sha256": sha256(data)}
            for name, data in zip(PACKAGES, [original_bytes, replacement_bytes])
        },
        "outputSha256": sha256(result),
        "outputIntegrity": "sha512-" + base64.b64encode(hashlib.sha512(result).digest()).decode(),
        "outputBytes": len(result),
        "unchangedFiles": len(untouched),
        "replacedPrefix": PREFIX,
        "removedFiles": sorted(name for name in original if name.startswith(PREFIX)),
        "replacementFiles": sorted(name for name in actual if name.startswith(PREFIX)),
        "contentChanges": [
            {"path": name, "beforeSha256": sha256(original[name][0]), "afterSha256": sha256(value[0])}
            for name, value in sorted(actual.items()) if name in original and value != original[name]
        ],
        "reproductionChecked": args.check,
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
