#!/usr/bin/env python3
"""Analyze the Terminal-Bench 2.0 public leaderboard submissions.

Walks the cloned HF dataset (`harborframework/terminal-bench-2-leaderboard`)
and aggregates the per-trial reward files into empirical success rates:

  * per-task    — pass rate across every trial of every agent/model (the
                  "which tasks are hardest" view; the numbers tbench.ai does
                  not publish as text)
  * per-model   — pass rate across all tasks (reconstructs the leaderboard)
  * per-agent   — pass rate grouped by agent scaffold
  * task x best — each task's best-performing model, to spot tasks no model solves

Each leaf `result.json` has:
    task_name                       -> "regex-chess"
    agent_info.name                 -> agent scaffold (e.g. "terminus-2")
    agent_info.model_info.name      -> model (e.g. "claude-opus-4-6")
    verifier_result.rewards.reward  -> 0.0 | 1.0   (1.0 == solved)
    exception_info                  -> null | {...} (harness error => excluded
                                       from rate, counted separately)

Usage:
    python analyze_leaderboard.py [--data DIR] [--top N] [--json OUT.json]
                                  [--task-filter SUBSTR] [--csv-dir DIR]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_DATA = Path(__file__).resolve().parent / "data" / "tb2-leaderboard"


@dataclass
class Agg:
    """Running tally of trials for some grouping key."""

    solved: int = 0
    attempted: int = 0  # trials with a real reward (exceptions excluded)
    errored: int = 0    # harness exceptions (no valid reward)

    def add(self, reward: float | None, errored: bool) -> None:
        if errored or reward is None:
            self.errored += 1
            return
        self.attempted += 1
        if reward >= 0.5:  # rewards are 0.0/1.0; >=0.5 guards float noise
            self.solved += 1

    @property
    def rate(self) -> float:
        return self.solved / self.attempted if self.attempted else 0.0


@dataclass
class Tallies:
    per_task: dict[str, Agg] = field(default_factory=lambda: defaultdict(Agg))
    per_model: dict[str, Agg] = field(default_factory=lambda: defaultdict(Agg))
    per_agent: dict[str, Agg] = field(default_factory=lambda: defaultdict(Agg))
    # task -> model -> Agg  (for "best model per task")
    task_model: dict[str, dict[str, Agg]] = field(
        default_factory=lambda: defaultdict(lambda: defaultdict(Agg))
    )
    total_files: int = 0
    parse_errors: int = 0


def iter_result_files(root: Path):
    """Yield every result.json under the submissions tree."""
    sub = root / "submissions"
    base = sub if sub.is_dir() else root
    for dirpath, _dirs, files in os.walk(base):
        if "result.json" in files:
            yield Path(dirpath) / "result.json"


def load(path: Path) -> dict | None:
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def normalize_task(name: str) -> str:
    """Collapse the inconsistent `terminal-bench/` org prefix and dotted/dashed
    version variants so the same task tallies under ONE key.

    Submissions disagree on naming: some write `terminal-bench/filter-js-from-html`,
    most write `filter-js-from-html`; `install-windows-3.11` vs `-3-11`. Without
    this, a task's trials split across 2-3 keys and produce phantom 0%/UNSOLVED
    shards with tiny n.
    """
    n = name.strip()
    if "/" in n:
        n = n.rsplit("/", 1)[1]  # drop org prefix
    # unify the windows version variant (3.11 == 3-11)
    n = n.replace("windows-3-11", "windows-3.11")
    return n


def _read_submission_models(meta: Path) -> str:
    """Read metadata.yaml's `models:` list -> single model name, or 'Multiple'.

    The block is YAML list form:
        models:
          - model_name: "anthropic/claude-opus-4-7"
            model_provider: ...
          - model_name: "gpt-5.5"        # (multi-model submissions)
    so after stripping, the salient lines start with '- model_name:' OR
    'model_name:'. >1 distinct entry => the per-trial model is ambiguous
    (blank in agent_info), so we label it 'Multiple'.
    """
    names: list[str] = []
    try:
        for line in meta.read_text().splitlines():
            s = line.strip().lstrip("-").strip()
            if s.startswith("model_name:"):
                v = s.split(":", 1)[1].strip().strip('"\'')
                if v:
                    names.append(v)
    except OSError:
        return "<unknown-model>"
    uniq = list(dict.fromkeys(names))
    if not uniq:
        return "<unknown-model>"
    return uniq[0] if len(uniq) == 1 else "Multiple"


def resolve_model(d: dict, path: Path, cache: dict[Path, str]) -> str:
    """Model name, preferring per-trial agent_info, falling back to the
    submission's metadata.yaml (which most runs populate instead of the
    per-trial record). Result is cached per submission dir.
    """
    ai = d.get("agent_info") or {}
    m = ((ai.get("model_info") or {}).get("name")) or ""
    if m:
        return m
    for parent in path.parents:
        if parent in cache:
            return cache[parent]
        meta = parent / "metadata.yaml"
        if meta.is_file():
            val = _read_submission_models(meta)
            cache[parent] = val
            return val
    return "<unknown-model>"


def collect(root: Path, task_filter: str | None = None) -> Tallies:
    t = Tallies()
    meta_cache: dict[Path, str] = {}
    for path in iter_result_files(root):
        t.total_files += 1
        d = load(path)
        if d is None:
            t.parse_errors += 1
            continue

        task = normalize_task(d.get("task_name") or "<unknown>")
        if task_filter and task_filter not in task:
            continue

        ai = d.get("agent_info") or {}
        agent = ai.get("name") or "<unknown-agent>"
        model = resolve_model(d, path, meta_cache)

        errored = d.get("exception_info") is not None
        reward = None
        vr = d.get("verifier_result") or {}
        rewards = vr.get("rewards") or {}
        if "reward" in rewards:
            try:
                reward = float(rewards["reward"])
            except (TypeError, ValueError):
                reward = None
        elif not errored:
            # No reward and no exception => treat as a failed/void trial.
            errored = True

        t.per_task[task].add(reward, errored)
        t.per_model[model].add(reward, errored)
        t.per_agent[agent].add(reward, errored)
        t.task_model[task][model].add(reward, errored)
    return t


def fmt_rate(a: Agg) -> str:
    return f"{a.rate * 100:5.1f}%  ({a.solved:>4}/{a.attempted:<4})"


def print_section(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def report(t: Tallies, top: int) -> None:
    print_section("DATASET")
    print(f"result.json files scanned : {t.total_files}")
    print(f"parse errors              : {t.parse_errors}")
    print(f"distinct tasks            : {len(t.per_task)}")
    print(f"distinct models           : {len(t.per_model)}")
    print(f"distinct agents           : {len(t.per_agent)}")
    total_trials = sum(a.attempted for a in t.per_task.values())
    total_err = sum(a.errored for a in t.per_task.values())
    print(f"scored trials             : {total_trials}")
    print(f"harness-errored trials    : {total_err} (excluded from rates)")

    # ---- Hardest tasks (lowest empirical success rate) ----
    print_section(f"LOWEST SUCCESS-RATE TASKS (hardest {top}) — across ALL models")
    # only tasks with real scored trials; an attempted==0 key is a naming
    # phantom, not a 0% task.
    tasks = sorted(
        ((k, a) for k, a in t.per_task.items() if a.attempted),
        key=lambda kv: (kv[1].rate, -kv[1].attempted),
    )
    print(f"{'rank':>4}  {'task':<42} {'pass-rate':>9}  solved/att  best-model")
    for i, (task, agg) in enumerate(tasks[:top], 1):
        # best model on this task
        models = t.task_model[task]
        best = max(
            (m for m in models.items() if m[1].attempted),
            key=lambda kv: kv[1].rate,
            default=None,
        )
        best_s = (
            f"{best[0]} ({best[1].rate * 100:.0f}%)" if best else "—"
        )
        flag = "  ⚠ UNSOLVED" if agg.solved == 0 and agg.attempted else ""
        print(
            f"{i:>4}  {task:<42} {agg.rate * 100:6.1f}%  "
            f"{agg.solved:>4}/{agg.attempted:<4}  {best_s}{flag}"
        )

    # ---- Tasks NO model ever solved ----
    never = [task for task, a in tasks if a.attempted and a.solved == 0]
    print_section(f"TASKS SOLVED BY NO MODEL ({len(never)})")
    for task in sorted(never):
        print(f"  {task}")

    # ---- Easiest tasks (sanity / contrast) ----
    print_section(f"HIGHEST SUCCESS-RATE TASKS (easiest {top})")
    for i, (task, agg) in enumerate(reversed(tasks[-top:]), 1):
        print(f"{i:>4}  {task:<42} {fmt_rate(agg)}")

    # ---- Leaderboard (per model) ----
    print_section("LEADERBOARD — per model (all agents, all tasks pooled)")
    models = sorted(
        ((k, a) for k, a in t.per_model.items() if a.attempted),
        key=lambda kv: -kv[1].rate,
    )
    print(f"{'rank':>4}  {'model':<34} {'pass-rate':>9}  solved/att")
    for i, (model, agg) in enumerate(models, 1):
        print(f"{i:>4}  {model:<34} {fmt_rate(agg)}")

    # ---- Per agent scaffold ----
    print_section("PER AGENT SCAFFOLD (all models pooled)")
    agents = sorted(
        ((k, a) for k, a in t.per_agent.items() if a.attempted),
        key=lambda kv: -kv[1].rate,
    )
    for agent, agg in agents:
        print(f"  {agent:<36} {fmt_rate(agg)}")


def to_json(t: Tallies) -> dict:
    def dump(d: dict[str, Agg]):
        return {
            k: {
                "rate": round(a.rate, 4),
                "solved": a.solved,
                "attempted": a.attempted,
                "errored": a.errored,
            }
            for k, a in d.items()
        }

    tasks_sorted = sorted(
        ((k, a) for k, a in t.per_task.items() if a.attempted),
        key=lambda kv: kv[1].rate,
    )
    return {
        "summary": {
            "files": t.total_files,
            "parse_errors": t.parse_errors,
            "tasks": len(t.per_task),
            "models": len(t.per_model),
            "agents": len(t.per_agent),
        },
        "tasks_by_difficulty": [
            {
                "task": task,
                "rate": round(a.rate, 4),
                "solved": a.solved,
                "attempted": a.attempted,
            }
            for task, a in tasks_sorted
        ],
        "per_task": dump(t.per_task),
        "per_model": dump(t.per_model),
        "per_agent": dump(t.per_agent),
    }


def write_csvs(t: Tallies, csv_dir: Path) -> None:
    import csv

    csv_dir.mkdir(parents=True, exist_ok=True)
    with open(csv_dir / "tasks.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["task", "pass_rate", "solved", "attempted", "errored"])
        for task, a in sorted(t.per_task.items(), key=lambda kv: kv[1].rate):
            if not a.attempted:
                continue
            w.writerow([task, f"{a.rate:.4f}", a.solved, a.attempted, a.errored])
    with open(csv_dir / "models.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["model", "pass_rate", "solved", "attempted", "errored"])
        for m, a in sorted(t.per_model.items(), key=lambda kv: -kv[1].rate):
            if not a.attempted:
                continue
            w.writerow([m, f"{a.rate:.4f}", a.solved, a.attempted, a.errored])
    # task x model matrix (pass rate)
    with open(csv_dir / "task_model_matrix.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        models = sorted(t.per_model)
        w.writerow(["task", *models])
        for task in sorted(t.per_task):
            row = [task]
            for m in models:
                a = t.task_model[task].get(m)
                row.append(f"{a.rate:.3f}" if a and a.attempted else "")
            w.writerow(row)
    print(f"\nCSVs written to {csv_dir}/ (tasks.csv, models.csv, task_model_matrix.csv)")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA,
                    help=f"leaderboard clone dir (default: {DEFAULT_DATA})")
    ap.add_argument("--top", type=int, default=25, help="N tasks/models to show")
    ap.add_argument("--task-filter", default=None,
                    help="only tasks whose name contains this substring")
    ap.add_argument("--json", type=Path, default=None, help="write full analysis JSON")
    ap.add_argument("--csv-dir", type=Path, default=None, help="write CSV tables here")
    args = ap.parse_args(argv)

    if not args.data.exists():
        print(f"error: data dir not found: {args.data}", file=sys.stderr)
        print("clone it first (LFS-skipped):", file=sys.stderr)
        print("  GIT_LFS_SKIP_SMUDGE=1 git clone \\\n"
              "    https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard \\\n"
              "    spell_harbor/data/tb2-leaderboard", file=sys.stderr)
        return 2

    t = collect(args.data, args.task_filter)
    if t.total_files == 0:
        print(f"error: no result.json found under {args.data}", file=sys.stderr)
        return 1

    report(t, args.top)
    if args.json:
        args.json.write_text(json.dumps(to_json(t), indent=2))
        print(f"\nFull analysis JSON -> {args.json}")
    if args.csv_dir:
        write_csvs(t, args.csv_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
