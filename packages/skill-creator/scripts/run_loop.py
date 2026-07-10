#!/usr/bin/env python3
import argparse, json, random, sys, tempfile, time, webbrowser
from pathlib import Path
from scripts.artifact_contract import load_optimizer_checkpoint, write_artifact
from scripts.generate_report import generate_html
from scripts.improve_description import improve_description
from scripts.run_eval import find_project_root, run_eval
from scripts.utils import parse_skill_md

def split_eval_set(eval_set, holdout, seed=42):
    random.seed(seed)
    trigger = [e for e in eval_set if e["should_trigger"]]
    no_trigger = [e for e in eval_set if not e["should_trigger"]]
    random.shuffle(trigger)
    random.shuffle(no_trigger)
    n_trigger_test = max(1, int(len(trigger) * holdout))
    n_no_trigger_test = max(1, int(len(no_trigger) * holdout))
    test_set = trigger[:n_trigger_test] + no_trigger[:n_no_trigger_test]
    train_set = trigger[n_trigger_test:] + no_trigger[n_no_trigger_test:]
    return train_set, test_set

def run_loop(eval_set, skill_path, description_override, num_workers, timeout, max_iterations, runs_per_query, trigger_threshold, holdout, model, verbose, live_report_path=None, log_dir=None, checkpoint_path=None, resume=False):
    project_root = find_project_root()
    name, original_description, content = parse_skill_md(skill_path)
    current_description = description_override or original_description
    history = []
    start_iteration = 1
    if checkpoint_path and resume:
        existing = load_optimizer_checkpoint(checkpoint_path)
        if existing:
            history = existing.get("history", [])
            current_description = existing.get("description", current_description)
            start_iteration = int(existing.get("iteration", 0)) + 1
            if verbose:
                print(f"Resuming from checkpoint at iteration {start_iteration}", file=sys.stderr)
    if holdout > 0:
        train_set, test_set = split_eval_set(eval_set, holdout)
        if verbose:
            print(f"Split: {len(train_set)} train, {len(test_set)} test (holdout={holdout})", file=sys.stderr)
    else:
        train_set = eval_set
        test_set = []
    exit_reason = "unknown"
    for iteration in range(start_iteration, max_iterations + 1):
        if verbose:
            print(f"\n{'='*60}", file=sys.stderr)
            print(f"Iteration {iteration}/{max_iterations}", file=sys.stderr)
            print(f"Description: {current_description}", file=sys.stderr)
            print(f"{'='*60}", file=sys.stderr)
        all_queries = train_set + test_set
        t0 = time.time()
        all_results = run_eval(eval_set=all_queries, skill_name=name, description=current_description, num_workers=num_workers, timeout=timeout, project_root=project_root, runs_per_query=runs_per_query, trigger_threshold=trigger_threshold, model=model)
        eval_elapsed = time.time() - t0
        train_queries_set = {q["query"] for q in train_set}
        train_result_list = [r for r in all_results["results"] if r["query"] in train_queries_set]
        test_result_list = [r for r in all_results["results"] if r["query"] not in train_queries_set]
        train_passed = sum(1 for r in train_result_list if r["pass"])
        train_total = len(train_result_list)
        train_summary = {"passed": train_passed, "failed": train_total - train_passed, "total": train_total}
        train_results = {"results": train_result_list, "summary": train_summary}
        if test_set:
            test_passed = sum(1 for r in test_result_list if r["pass"])
            test_total = len(test_result_list)
            test_summary = {"passed": test_passed, "failed": test_total - test_passed, "total": test_total}
            test_results = {"results": test_result_list, "summary": test_summary}
        else:
            test_results = None
            test_summary = None
        history.append({"iteration": iteration, "description": current_description, "train_passed": train_summary["passed"], "train_failed": train_summary["failed"], "train_total": train_summary["total"], "train_results": train_results["results"], "test_passed": test_summary["passed"] if test_summary else None, "test_failed": test_summary["failed"] if test_summary else None, "test_total": test_summary["total"] if test_summary else None, "test_results": test_results["results"] if test_results else None, "passed": train_summary["passed"], "failed": train_summary["failed"], "total": train_summary["total"], "results": train_results["results"]})
        if checkpoint_path:
            write_artifact(checkpoint_path, "optimizer_checkpoint", {
                "iteration": iteration,
                "history": history,
                "description": current_description,
            })
        if live_report_path:
            partial_output = {"original_description": original_description, "best_description": current_description, "best_score": "in progress", "iterations_run": len(history), "holdout": holdout, "train_size": len(train_set), "test_size": len(test_set), "history": history}
            live_report_path.write_text(generate_html(partial_output, auto_refresh=True, skill_name=name))
        if verbose:
            def print_eval_stats(label, results, elapsed):
                pos = [r for r in results if r["should_trigger"]]
                neg = [r for r in results if not r["should_trigger"]]
                tp = sum(r["triggers"] for r in pos)
                pos_runs = sum(r["runs"] for r in pos)
                fn = pos_runs - tp
                fp = sum(r["triggers"] for r in neg)
                neg_runs = sum(r["runs"] for r in neg)
                tn = neg_runs - fp
                total = tp + tn + fp + fn
                precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
                recall = tp / (tp + fn) if (tp + fn) > 0 else 1.0
                accuracy = (tp + tn) / total if total > 0 else 0.0
                print(f"{label}: {tp+tn}/{total} correct, precision={precision:.0%} recall={recall:.0%} accuracy={accuracy:.0%} ({elapsed:.1f}s)", file=sys.stderr)
                for r in results:
                    status = "PASS" if r["pass"] else "FAIL"
                    rate_str = f"{r['triggers']}/{r['runs']}"
                    print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:60]}", file=sys.stderr)
            print_eval_stats("Train", train_results["results"], eval_elapsed)
            if test_summary:
                print_eval_stats("Test ", test_results["results"], 0)
        if train_summary["failed"] == 0:
            exit_reason = f"all_passed (iteration {iteration})"
            if verbose:
                print(f"\nAll train queries passed on iteration {iteration}!", file=sys.stderr)
            break
        if iteration == max_iterations:
            exit_reason = f"max_iterations ({max_iterations})"
            if verbose:
                print(f"\nMax iterations reached ({max_iterations}).", file=sys.stderr)
            break
        if verbose:
            print(f"\nImproving description...", file=sys.stderr)
        t0 = time.time()
        blinded_history = [{k: v for k, v in h.items() if not k.startswith("test_")} for h in history]
        new_description = improve_description(skill_name=name, skill_content=content, current_description=current_description, eval_results=train_results, history=blinded_history, model=model, log_dir=log_dir, iteration=iteration)
        improve_elapsed = time.time() - t0
        if verbose:
            print(f"Proposed ({improve_elapsed:.1f}s): {new_description}", file=sys.stderr)
        current_description = new_description
    if test_set:
        best = max(history, key=lambda h: h["test_passed"] or 0)
        best_score = f"{best['test_passed']}/{best['test_total']}"
    else:
        best = max(history, key=lambda h: h["train_passed"])
        best_score = f"{best['train_passed']}/{best['train_total']}"
    if verbose:
        print(f"\nExit reason: {exit_reason}", file=sys.stderr)
        print(f"Best score: {best_score} (iteration {best['iteration']})", file=sys.stderr)
    return {"exit_reason": exit_reason, "original_description": original_description, "best_description": best["description"], "best_score": best_score, "best_train_score": f"{best['train_passed']}/{best['train_total']}", "best_test_score": f"{best['test_passed']}/{best['test_total']}" if test_set else None, "final_description": current_description, "iterations_run": len(history), "holdout": holdout, "train_size": len(train_set), "test_size": len(test_set), "history": history}

def main():
    parser = argparse.ArgumentParser(description="Run eval + improve loop")
    parser.add_argument("--eval-set", required=True)
    parser.add_argument("--skill-path", required=True)
    parser.add_argument("--description", default=None)
    parser.add_argument("--num-workers", type=int, default=10)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--max-iterations", type=int, default=5)
    parser.add_argument("--runs-per-query", type=int, default=3)
    parser.add_argument("--trigger-threshold", type=float, default=0.5)
    parser.add_argument("--holdout", type=float, default=0.4)
    parser.add_argument("--model", required=True)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--report", default="auto")
    parser.add_argument("--results-dir", default=None)
    parser.add_argument("--resume", action="store_true", help="Resume from optimizer_checkpoint.json in results-dir")
    args = parser.parse_args()
    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)
    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr); sys.exit(1)
    name, _, _ = parse_skill_md(skill_path)
    if args.report != "none":
        if args.report == "auto":
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            live_report_path = Path(tempfile.gettempdir()) / f"skill_description_report_{skill_path.name}_{timestamp}.html"
        else:
            live_report_path = Path(args.report)
        live_report_path.write_text("<html><body><h1>Starting optimization loop...</h1><meta http-equiv='refresh' content='5'></body></html>")
        webbrowser.open(str(live_report_path))
    else:
        live_report_path = None
    if args.results_dir:
        timestamp = time.strftime("%Y-%m-%d_%H%M%S")
        results_dir = Path(args.results_dir) / timestamp
        results_dir.mkdir(parents=True, exist_ok=True)
    else:
        results_dir = None
    log_dir = results_dir / "logs" if results_dir else None
    checkpoint_path = results_dir / "optimizer_checkpoint.json" if results_dir else None
    output = run_loop(eval_set=eval_set, skill_path=skill_path, description_override=args.description, num_workers=args.num_workers, timeout=args.timeout, max_iterations=args.max_iterations, runs_per_query=args.runs_per_query, trigger_threshold=args.trigger_threshold, holdout=args.holdout, model=args.model, verbose=args.verbose, live_report_path=live_report_path, log_dir=log_dir, checkpoint_path=checkpoint_path, resume=args.resume)
    json_output = json.dumps(output, indent=2)
    print(json_output)
    if results_dir:
        (results_dir / "results.json").write_text(json_output)
    if live_report_path:
        live_report_path.write_text(generate_html(output, auto_refresh=False, skill_name=name))
        print(f"\nReport: {live_report_path}", file=sys.stderr)
    if results_dir and live_report_path:
        (results_dir / "report.html").write_text(generate_html(output, auto_refresh=False, skill_name=name))
    if results_dir:
        print(f"Results saved to: {results_dir}", file=sys.stderr)

if __name__ == "__main__":
    main()
