#!/usr/bin/env python3
"""Deterministically assemble the authored game modules into the two entry pages."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
MODULES = ("core", "gameplay", "combat", "ai-dm", "online", "bootstrap")


def outputs():
    template = (ROOT / "src/game.html").read_text(encoding="utf-8")
    marker = "<!-- AETHELGARD_SCRIPTS -->"
    if template.count(marker) != 1:
        raise ValueError("The game template must contain exactly one script marker")
    registry = json.loads((ROOT / "models/registry.json").read_text(encoding="utf-8"))
    chunks = ["window.AETHELGARD_MODEL_REGISTRY = " + json.dumps(registry, ensure_ascii=False) + ";"]
    chunks.extend((ROOT / f"src/{name}.js").read_text(encoding="utf-8") for name in MODULES)
    javascript = re.sub(r"</script", r"<\\/script", "\n\n".join(chunks), flags=re.IGNORECASE)
    html = template.replace(marker, "<script>\n" + javascript + "\n</script>")
    fingerprint = hashlib.sha256(html.encode())
    for name in ("assets/game.css", "assets/ai-worker.js"):
        fingerprint.update((ROOT / name).read_bytes())
    sw = (ROOT / "src/service-worker.js").read_text(encoding="utf-8").replace("__BUILD_ID__", fingerprint.hexdigest()[:16])
    return {"index.html": html, "open_world_mud.html": html, "sw.js": sw}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if a generated file is stale")
    args = parser.parse_args()
    stale = []
    for name, content in outputs().items():
        destination = ROOT / name
        if args.check:
            if not destination.is_file() or destination.read_text(encoding="utf-8") != content:
                stale.append(name)
        else:
            destination.write_text(content, encoding="utf-8", newline="\n")
    if stale:
        parser.exit(1, "Stale generated files: " + ", ".join(stale) + "\nRun npm run build.\n")
    print("Generated game matches source." if args.check else "Built index.html, open_world_mud.html and sw.js.")


if __name__ == "__main__":
    main()
