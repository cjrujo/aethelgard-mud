#!/usr/bin/env python3
"""Run the current regression suite and save an auditable fresh report."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", default="test-results/verification.json")
    args = parser.parse_args()
    node_tests = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "tests").glob("*.test.mjs"))
    if not node_tests:
        parser.exit(1, "No JavaScript regression tests found.\n")
    commands = [[sys.executable, "src/build_mud_game.py", "--check"],
                ["node", "--test", "--experimental-test-isolation=none", "--test-reporter=tap", *node_tests],
                [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"]]
    report = {"timestamp": datetime.now(timezone.utc).isoformat(), "commands": [],
              "modelInferenceIncluded": False, "browserIncluded": False,
              "note": "Fresh v11 verification; historical test counts are not reused.",
              "sourceSha256": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                               for p in sorted((ROOT / "src").glob("*")) if p.is_file()}}
    for command in commands:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        output = result.stdout + result.stderr
        print("$ " + " ".join(command), flush=True)
        print(output, end="" if output.endswith("\n") else "\n", flush=True)
        entry = {"command": command, "exitCode": result.returncode, "output": output}
        match = re.search(r"^# tests (\d+)$", output, re.M) or re.search(r"Ran (\d+) tests? in", output)
        if match:
            entry["tests"] = int(match.group(1))
        report["commands"].append(entry)
    report["passed"] = all(item["exitCode"] == 0 for item in report["commands"])
    destination = ROOT / args.report
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Verification report:", destination)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
