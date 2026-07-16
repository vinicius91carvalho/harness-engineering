#!/usr/bin/env python3
"""Live view of a Cursor Task-subagent's transcript, for a herdr pane.

Cursor CLI subagents do not run in a terminal - they run inside the parent
agent process and stream to their own transcript JSONL. This tail-follows that
transcript and renders it as readable activity so the herdr pane shows what the
subagent is actually doing.

Invoked as: herdr-subagent-logview.py <meta.json>
where meta.json carries the correlation hints written by the start hook:
  { transcripts_dir, parent_conversation_id, prompt_snippet, start_epoch,
    type, task }

Correlation: the subagent's transcript is a NEW *.jsonl (mtime >= start) whose
basename differs from the parent conversation id and whose first user message
contains prompt_snippet. Fail soft: never crash the pane shell.
"""
import glob
import json
import os
import re
import subprocess
import sys
import time

RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
GREEN = "\033[32m"


def norm(text):
    return re.sub(r"\s+", " ", text or "").strip()


def read_meta(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def first_user_text(path):
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                if d.get("role") != "user":
                    continue
                return message_text(d.get("message") or d)
    except Exception:
        pass
    return ""


def message_text(message):
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    out = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                out.append(block.get("text", ""))
    return "\n".join(out)


def find_transcript(meta, deadline):
    tdir = meta.get("transcripts_dir") or ""
    parent = meta.get("parent_conversation_id") or ""
    snippet = norm(meta.get("prompt_snippet") or "")[:400]
    start = float(meta.get("start_epoch") or 0) - 3
    if not tdir or not os.path.isdir(tdir):
        return None
    while time.time() < deadline:
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
        if candidates:
            if snippet:
                for path in sorted(candidates, key=os.path.getmtime, reverse=True):
                    if snippet in norm(first_user_text(path)):
                        return path
            if len(candidates) == 1:
                return candidates[0]
        time.sleep(1)
    return None


def render_line(d):
    role = d.get("role")
    message = d.get("message") or d
    content = message.get("content")
    blocks = content if isinstance(content, list) else []
    if isinstance(content, str) and role == "assistant":
        blocks = [{"type": "text", "text": content}]
    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text" and role == "assistant":
            text = block.get("text", "").strip()
            if text:
                print(text + "\n", flush=True)
        elif btype in ("tool_use", "toolUse"):
            name = block.get("name", "tool")
            summary = tool_summary(block.get("input") or {})
            print(f"{CYAN}\u00b7 {name}{RESET} {DIM}{summary}{RESET}", flush=True)


def close_own_tab(meta):
    """Close this pane's tab via herdr; used when the subagent finishes."""
    tab_id = meta.get("tab_id") or ""
    if not tab_id:
        return
    try:
        subprocess.run(
            ["herdr", "tab", "close", tab_id],
            capture_output=True,
            timeout=10,
        )
    except Exception:
        pass


# Cursor transcripts often omit turn_ended. After this much silence following
# at least one assistant/tool line, treat the subagent as finished.
IDLE_FINISH_SECONDS = 45
# If we never find a transcript, do not sleep forever — close the mirror tab.
NO_TRANSCRIPT_SECONDS = 90


def tool_summary(inp):
    if not isinstance(inp, dict):
        return ""
    for key in ("command", "query", "pattern", "path", "file_path",
                "target_file", "description", "prompt"):
        val = inp.get(key)
        if isinstance(val, str) and val.strip():
            return norm(val)[:100]
    return norm(json.dumps(inp))[:100]


def finish_and_close(meta, reason):
    print(f"{BOLD}{GREEN}\u25a0 subagent finished ({reason}), closing tab{RESET}", flush=True)
    time.sleep(1)
    close_own_tab(meta)


def main():
    if len(sys.argv) < 2:
        print("no meta file", flush=True)
        return
    meta = read_meta(sys.argv[1])
    stype = meta.get("type") or "subagent"
    task = meta.get("task") or ""
    print(f"{BOLD}{GREEN}\u25b6 Cursor subagent{RESET} {BOLD}{stype}{RESET}", flush=True)
    if task:
        print(f"{DIM}task:{RESET} {task}\n", flush=True)
    print(f"{DIM}locating transcript...{RESET}", flush=True)

    path = find_transcript(meta, deadline=time.time() + 45)
    if not path:
        print(f"{YELLOW}Could not locate the subagent transcript.{RESET}", flush=True)
        print(f"{DIM}closing mirror tab after {NO_TRANSCRIPT_SECONDS}s{RESET}", flush=True)
        time.sleep(NO_TRANSCRIPT_SECONDS)
        finish_and_close(meta, "no-transcript")
        return

    print(f"{DIM}transcript:{RESET} {path}\n", flush=True)
    pos = 0
    idle = 0
    saw_activity = False
    while True:
        finished = False
        try:
            size = os.path.getsize(path)
            if size > pos:
                with open(path, encoding="utf-8") as fh:
                    fh.seek(pos)
                    chunk = fh.read()
                    pos = fh.tell()
                for line in chunk.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    saw_activity = True
                    if '"turn_ended"' in line:
                        finished = True
                    try:
                        render_line(json.loads(line))
                    except Exception:
                        pass
                idle = 0
            else:
                idle += 1
        except OSError:
            idle += 1
        if finished:
            finish_and_close(meta, "turn_ended")
            return
        if saw_activity and idle >= IDLE_FINISH_SECONDS:
            finish_and_close(meta, f"idle-{IDLE_FINISH_SECONDS}s")
            return
        # No activity at all for a long stretch after open — still close.
        if not saw_activity and idle >= NO_TRANSCRIPT_SECONDS:
            finish_and_close(meta, "silent-transcript")
            return
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        # Never sleep forever — that is what left zombie "working" tabs.
        try:
            meta = read_meta(sys.argv[1]) if len(sys.argv) > 1 else {}
            print(f"{YELLOW}logview error: {exc}{RESET}", flush=True)
            finish_and_close(meta, "logview-error")
        except Exception:
            pass
