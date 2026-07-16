#!/bin/bash
# Mirror Cursor Task-tool subagents into herdr so they show up as agents in the
# sidebar, each in its own tab with a live view of what it is doing.
#
# The cursor-agent CLI (unlike the IDE) never fires the subagentStart /
# subagentStop hook events, so this integration is driven by the events the
# CLI *does* fire:
#   start  <- preToolUse hook, matched to the "Task" tool (one per subagent)
#   stop   <- stop hook (parent turn complete -> every subagent is done)
#
# There is no per-subagent stop signal on the CLI (Task does not emit
# postToolUse and subagentStop never fires). Background subagents
# (run_in_background) outlive the parent turn, so the stop handler must not
# tear everything down blindly: it closes only subagents whose transcript
# tail shows a turn_ended event (or that look stale), and keeps the rest for
# the next stop sweep (a stop fires at the end of every parent turn).
#
# CLI subagents do not run in a terminal; they run inside the parent process
# and stream to their own transcript JSONL. Each subagent tab runs
# herdr-subagent-logview.py, which locates that transcript (by prompt snippet)
# and tail-follows it so the tab shows real activity.
#
# Fail open: hooks must never block Cursor.

set +e

action="${1:-}"
hook_input_file="$(mktemp "${TMPDIR:-/tmp}/herdr-cursor-subagent.XXXXXX")" || exit 0
trap 'rm -f "$hook_input_file"' EXIT HUP INT TERM
cat >"$hook_input_file" 2>/dev/null || true

case "$action" in
  start|stop) ;;
  *) exit 0 ;;
esac

[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
command -v herdr >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

HERDR_ACTION="$action" \
HERDR_HOOK_INPUT_FILE="$hook_input_file" \
HERDR_TRANSCRIPTS_DIR="${AGENT_TRANSCRIPTS:-}" \
HERDR_REGISTRY="/home/vinicius/.cursor/herdr-subagent-registry.json" \
HERDR_REGISTRY_LOCK="/home/vinicius/.cursor/herdr-subagent-registry.lock" \
HERDR_META_DIR="/home/vinicius/.cursor/herdr-subagent-meta" \
HERDR_LOGVIEW="/home/vinicius/.cursor/herdr-subagent-logview.py" \
HERDR_SOURCE="user:cursor-subagent" \
python3 - <<'PY'
import glob
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone

action = os.environ.get("HERDR_ACTION", "")
parent_pane_id = os.environ.get("HERDR_PANE_ID", "")
transcripts_dir = os.environ.get("HERDR_TRANSCRIPTS_DIR", "")
registry_path = os.environ.get("HERDR_REGISTRY", "")
registry_lock = os.environ.get("HERDR_REGISTRY_LOCK", "")
meta_dir = os.environ.get("HERDR_META_DIR", "")
logview = os.environ.get("HERDR_LOGVIEW", "")
source = os.environ.get("HERDR_SOURCE", "user:cursor-subagent")
hook_input_file = os.environ.get("HERDR_HOOK_INPUT_FILE", "")

TASK_TOOL_NAMES = {"Task", "Subagent"}


def fail_open():
    raise SystemExit(0)


def load_hook_input():
    if not hook_input_file:
        return {}
    try:
        with open(hook_input_file, encoding="utf-8") as handle:
            content = handle.read()
        if content.strip():
            return json.loads(content)
    except Exception:
        pass
    return {}


def first_text(hook_input, *keys):
    for key in keys:
        value = hook_input.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def sanitize_agent_suffix(subagent_id):
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "", subagent_id or "")
    return (cleaned or "unknown")[-8:]


def sanitize_label_text(text, max_len=40):
    collapsed = re.sub(r"\s+", " ", text or "").strip()
    if len(collapsed) <= max_len:
        return collapsed
    return collapsed[: max_len - 1] + "\u2026"


def run_herdr(*args, timeout=5):
    try:
        subprocess.run(
            ["herdr", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except Exception:
        pass


def herdr_json(*args, timeout=5):
    try:
        proc = subprocess.run(
            ["herdr", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode != 0:
            return None
        payload = json.loads(proc.stdout or "{}")
        if "error" in payload:
            return None
        return payload.get("result", {})
    except Exception:
        return None


def tab_exists(tab_id):
    if not tab_id:
        return False
    return herdr_json("tab", "get", tab_id) is not None


def parent_pane_info():
    result = herdr_json("pane", "get", parent_pane_id)
    pane = (result or {}).get("pane", {})
    return pane.get("workspace_id") or "", pane.get("cwd") or ""


def resolve_transcripts_dir(cwd):
    # AGENT_TRANSCRIPTS is not reliably exported to hook subprocesses, so derive
    # the per-project transcripts directory from the parent cwd. Cursor slugs a
    # project path by replacing every non-alphanumeric run with a single dash.
    if transcripts_dir and os.path.isdir(transcripts_dir):
        return transcripts_dir
    if cwd:
        slug = re.sub(r"[^A-Za-z0-9]+", "-", cwd).strip("-")
        candidate = os.path.join(
            os.path.expanduser("~"), ".cursor", "projects", slug, "agent-transcripts"
        )
        if os.path.isdir(candidate):
            return candidate
    return transcripts_dir or ""


def load_registry():
    if not registry_path or not os.path.isfile(registry_path):
        return {}
    try:
        with open(registry_path, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_registry(registry):
    if not registry_path:
        return
    directory = os.path.dirname(registry_path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp_path = f"{registry_path}.tmp.{os.getpid()}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(registry, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(tmp_path, registry_path)
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass


class RegistryLock:
    def __init__(self, path):
        self.path = path
        self.handle = None

    def __enter__(self):
        if not self.path:
            return self
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        try:
            import fcntl

            self.handle = open(self.path, "a+", encoding="utf-8")
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX)
        except Exception:
            self.handle = None
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.handle is None:
            return False
        try:
            import fcntl

            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            self.handle.close()
        except Exception:
            pass
        return False


def entries_for_parent(registry, parent_id):
    return [
        (sid, entry)
        for sid, entry in registry.items()
        if isinstance(entry, dict) and entry.get("parent_pane_id") == parent_id
    ]


def prune_dead(registry, parent_id):
    for sid, entry in entries_for_parent(registry, parent_id):
        if not tab_exists(entry.get("tab_id")):
            remove_meta(entry.get("meta_path"))
            registry.pop(sid, None)


def refresh_parent_status(registry, parent_id):
    count = len(entries_for_parent(registry, parent_id))
    if count <= 0:
        run_herdr(
            "pane", "report-metadata", parent_id,
            "--source", source, "--clear-custom-status",
        )
        return
    label = f"{count} subagent" if count == 1 else f"{count} subagents"
    run_herdr(
        "pane", "report-metadata", parent_id,
        "--source", source, "--custom-status", label,
    )


def write_meta(subagent_id, meta):
    if not meta_dir:
        return ""
    try:
        os.makedirs(meta_dir, exist_ok=True)
        path = os.path.join(meta_dir, f"{sanitize_agent_suffix(subagent_id)}-{os.getpid()}.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(meta, handle)
        return path
    except Exception:
        return ""


def remove_meta(path):
    if path:
        try:
            os.remove(path)
        except Exception:
            pass


def create_tab(workspace_id, cwd, label):
    args = ["tab", "create", "--no-focus", "--label", label]
    if workspace_id:
        args += ["--workspace", workspace_id]
    if cwd:
        args += ["--cwd", cwd]
    result = herdr_json(*args)
    if not result:
        return None, None
    tab_id = result.get("tab", {}).get("tab_id")
    root_pane_id = result.get("root_pane", {}).get("pane_id")
    return tab_id, root_pane_id


def handle_start(hook_input):
    # Driven by the preToolUse hook; only Task-tool calls spawn subagents.
    tool_name = first_text(hook_input, "tool_name", "toolName")
    if tool_name not in TASK_TOOL_NAMES:
        fail_open()

    subagent_id = first_text(
        hook_input, "tool_use_id", "toolUseId", "tool_call_id", "toolCallId"
    )
    if not subagent_id:
        fail_open()

    tool_input = hook_input.get("tool_input") or hook_input.get("toolInput") or {}
    if not isinstance(tool_input, dict):
        tool_input = {}

    st = tool_input.get("subagent_type") or tool_input.get("subagentType")
    subagent_type = st if isinstance(st, str) and st.strip() else "subagent"
    prompt = tool_input.get("prompt") if isinstance(tool_input.get("prompt"), str) else ""
    task = (
        tool_input.get("description")
        or prompt
        or subagent_type
    )
    conversation_id = first_text(
        hook_input, "conversation_id", "conversationId", "session_id", "sessionId"
    )

    with RegistryLock(registry_lock):
        registry = load_registry()
        prune_dead(registry, parent_pane_id)

        existing = registry.get(subagent_id)
        if isinstance(existing, dict) and tab_exists(existing.get("tab_id")):
            fail_open()

        workspace_id, cwd = parent_pane_info()
        tdir = resolve_transcripts_dir(cwd)
        task_short = sanitize_label_text(task, 32)
        tab_label = sanitize_label_text(f"\U0001f9ee {subagent_type}: {task_short}", 48)

        tab_id, root_pane_id = create_tab(workspace_id, cwd, tab_label)
        if not tab_id or not root_pane_id:
            fail_open()

        agent_label = f"cursor-sub-{sanitize_agent_suffix(subagent_id)}"
        seq = time.time_ns()
        message = sanitize_label_text(task, 120)

        meta = {
            "transcripts_dir": tdir,
            "parent_conversation_id": conversation_id or "",
            "prompt_snippet": (prompt or task or "")[:2000],
            "start_epoch": time.time(),
            "type": subagent_type,
            "task": message,
            # Lets the logview close its own tab the moment the subagent's
            # transcript shows turn_ended, instead of waiting for the next
            # parent stop sweep.
            "tab_id": tab_id,
        }
        meta_path = write_meta(subagent_id, meta)

        run_herdr(
            "pane", "report-agent", root_pane_id,
            "--source", source,
            "--agent", agent_label,
            "--state", "working",
            "--custom-status", subagent_type,
            "--message", message,
            "--seq", str(seq),
        )

        if meta_path and logview:
            run_herdr(
                "pane", "run", root_pane_id,
                f"python3 {json.dumps(logview)} {json.dumps(meta_path)}",
            )

        registry[subagent_id] = {
            "tab_id": tab_id,
            "root_pane_id": root_pane_id,
            "workspace_id": workspace_id,
            "parent_pane_id": parent_pane_id,
            "conversation_id": conversation_id or "",
            "meta_path": meta_path,
            "agent": agent_label,
            "type": subagent_type,
            "task": message,
            "seq": seq,
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        save_registry(registry)
        refresh_parent_status(registry, parent_pane_id)


def norm_ws(text):
    return re.sub(r"\s+", " ", text or "").strip()


def first_user_text(path):
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                data = json.loads(line)
                if data.get("role") != "user":
                    continue
                message = data.get("message") or data
                content = message.get("content")
                if isinstance(content, str):
                    return content
                parts = []
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            parts.append(block.get("text", ""))
                return "\n".join(parts)
    except Exception:
        pass
    return ""


def locate_transcript(meta):
    tdir = meta.get("transcripts_dir") or ""
    parent = meta.get("parent_conversation_id") or ""
    snippet = norm_ws(meta.get("prompt_snippet") or "")[:400]
    start = float(meta.get("start_epoch") or 0) - 3
    if not tdir or not os.path.isdir(tdir):
        return None
    candidates = []
    for path in glob.glob(os.path.join(tdir, "*", "*.jsonl")):
        base = os.path.splitext(os.path.basename(path))[0]
        if parent and base == parent:
            continue
        try:
            if os.path.getmtime(path) < start:
                continue
        except OSError:
            continue
        candidates.append(path)
    if snippet:
        for path in sorted(candidates, key=os.path.getmtime, reverse=True):
            if snippet in norm_ws(first_user_text(path)):
                return path
    if len(candidates) == 1:
        return candidates[0]
    return None


def subagent_finished(entry):
    """True if the transcript shows a turn_ended event, False if it is still
    streaming, None if the transcript cannot be located."""
    meta = {}
    meta_path = entry.get("meta_path") or ""
    if meta_path:
        try:
            with open(meta_path, encoding="utf-8") as handle:
                meta = json.load(handle)
        except Exception:
            meta = {}
    path = locate_transcript(meta)
    if not path:
        return None
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            handle.seek(max(0, size - 8192))
            tail = handle.read().decode("utf-8", "replace")
        return '"turn_ended"' in tail
    except Exception:
        return None


def entry_age_seconds(entry):
    started = entry.get("started_at") or ""
    try:
        started_dt = datetime.fromisoformat(started)
        return (datetime.now(timezone.utc) - started_dt).total_seconds()
    except Exception:
        return float("inf")


# Keep an unlocatable-transcript tab around this long before assuming the
# subagent died without a transcript and reaping its tab.
# Was 900s — that left zombie "working" tabs for 15 minutes after Tasks ended.
ORPHAN_GRACE_SECONDS = 120
# If transcript mtime is this stale and logview is gone, close even without
# turn_ended (Cursor transcripts often omit that marker).
STALE_TRANSCRIPT_SECONDS = 60


def logview_alive(meta_path):
    if not meta_path:
        return None
    try:
        proc = subprocess.run(
            ["ps", "-eo", "args="],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode != 0:
            return None
        needle = meta_path
        for line in (proc.stdout or "").splitlines():
            if "herdr-subagent-logview" in line and needle in line:
                return True
        return False
    except Exception:
        return None


def transcript_stale(entry):
    meta = {}
    meta_path = entry.get("meta_path") or ""
    if meta_path:
        try:
            with open(meta_path, encoding="utf-8") as handle:
                meta = json.load(handle)
        except Exception:
            meta = {}
    path = locate_transcript(meta)
    if not path:
        return None
    try:
        age = time.time() - os.path.getmtime(path)
        return age >= STALE_TRANSCRIPT_SECONDS
    except Exception:
        return None


def handle_stop(hook_input):
    # Driven by the stop hook at the end of every parent turn. Foreground
    # subagents are done by now, but background subagents (run_in_background)
    # keep running across turns, so only close tabs whose transcript shows a
    # turn_ended event — or that are stale / logview-dead / orphaned.
    with RegistryLock(registry_lock):
        registry = load_registry()
        entries = entries_for_parent(registry, parent_pane_id)
        if not entries:
            fail_open()

        for subagent_id, entry in entries:
            finished = subagent_finished(entry)
            age = entry_age_seconds(entry)
            alive = logview_alive(entry.get("meta_path") or "")
            stale = transcript_stale(entry)
            keep = False
            if finished is True:
                keep = False  # close
            elif alive is False:
                keep = False  # close
            elif stale is True:
                keep = False  # close
            elif finished is None and age >= ORPHAN_GRACE_SECONDS:
                keep = False  # close
            elif finished is False and alive is not False and stale is not True:
                keep = True  # still running
            elif age < ORPHAN_GRACE_SECONDS:
                keep = True  # young unknown
            else:
                keep = False  # old unknown -> close
            if keep:
                continue
            tab_id = entry.get("tab_id")
            if tab_exists(tab_id):
                run_herdr("tab", "close", tab_id)
            remove_meta(entry.get("meta_path"))
            registry.pop(subagent_id, None)

        save_registry(registry)
        refresh_parent_status(registry, parent_pane_id)


hook_input = load_hook_input()

if action == "start":
    handle_start(hook_input)
elif action == "stop":
    handle_stop(hook_input)

fail_open()
PY
