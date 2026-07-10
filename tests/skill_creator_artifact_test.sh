#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/skill-creator"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$PKG"

python3 - <<'PY'
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))

from scripts.artifact_contract import (
    ArtifactContractError,
    eval_result_payload,
    grade_result_payload,
    load_optimizer_checkpoint,
    read_artifact,
    validate_artifact,
    write_artifact,
)

tmpdir = Path(tempfile.mkdtemp())

# eval_result round-trip fields
row = eval_result_payload(1, "test query", True, should_trigger=True)
assert row["id"] == 1 and row["pass"] is True

# grade_result
grade = grade_result_payload(7, 0.85)
assert grade["score"] == 0.85

# optimizer_checkpoint write/load
ckpt = tmpdir / "optimizer_checkpoint.json"
write_artifact(
    ckpt,
    "optimizer_checkpoint",
    {"iteration": 2, "history": [{"iteration": 1}], "description": "desc"},
)
loaded = load_optimizer_checkpoint(ckpt)
assert loaded is not None
assert loaded["iteration"] == 2
assert loaded["description"] == "desc"
assert loaded["version"] == 1

# benchmark write/read
bench_path = tmpdir / "benchmark.json"
write_artifact(
    bench_path,
    "benchmark",
    {"runs": [{"eval_id": 1, "configuration": "with_skill", "run_number": 1}]},
)
bench = read_artifact(bench_path, "benchmark")
assert bench["version"] == 1
assert len(bench["runs"]) == 1

# invalid artifact rejected
try:
    validate_artifact("eval_result", {"query": "x"})
    raise SystemExit("expected ArtifactContractError")
except ArtifactContractError:
    pass

print("skill_creator_artifact_test: ok")
PY
