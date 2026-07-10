"""Versioned skill-creator artifact contract (stdlib only)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

REQUIRED = {
    "eval_result": {"id", "query", "pass"},
    "grade_result": {"id", "score"},
    "benchmark": {"version", "runs"},
    "optimizer_checkpoint": {"version", "iteration", "history", "description"},
}


class ArtifactContractError(ValueError):
    pass


def validate_artifact(kind: str, data: Any) -> dict:
    if not isinstance(data, dict):
        raise ArtifactContractError(f"{kind} must be an object")
    version = data.get("version", SCHEMA_VERSION)
    if int(version) != SCHEMA_VERSION:
        raise ArtifactContractError(f"{kind} unsupported version {version}")
    required = REQUIRED.get(kind)
    if required:
        missing = required - set(data)
        if missing:
            raise ArtifactContractError(f"{kind} missing fields: {sorted(missing)}")
    return data


def read_artifact(path: str | Path, kind: str) -> dict:
    text = Path(path).read_text(encoding="utf-8")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ArtifactContractError(f"invalid JSON in {path}: {exc}") from exc
    return validate_artifact(kind, data)


def write_artifact(path: str | Path, kind: str, data: dict) -> None:
    payload = {"version": SCHEMA_VERSION, **data}
    validate_artifact(kind, payload)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def load_optimizer_checkpoint(path: str | Path) -> dict | None:
    p = Path(path)
    if not p.exists():
        return None
    return read_artifact(p, "optimizer_checkpoint")


def eval_result_payload(
    result_id: int | str,
    query: str,
    passed: bool,
    **extra: Any,
) -> dict:
    """Build and validate a single eval_result artifact."""
    payload = {"id": result_id, "query": query, "pass": passed, **extra}
    return validate_artifact("eval_result", payload)


def grade_result_payload(result_id: int | str, score: float) -> dict:
    """Build and validate a grade_result artifact."""
    return validate_artifact("grade_result", {"id": result_id, "score": score})


def grade_result_from_grading(grading: dict, eval_id: int | str) -> dict:
    """Derive a grade_result from a grader grading.json object."""
    score = grading.get("summary", {}).get("pass_rate", 0.0)
    return grade_result_payload(eval_id, score)
