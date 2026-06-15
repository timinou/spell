# Terminal-Bench 2.0 — Leaderboard Analysis

`analyze_leaderboard.py` aggregates the **public** Terminal-Bench 2.0 submission
data into the empirical per-task / per-model / per-agent success rates that
`tbench.ai` does **not** publish as text (the site shows only agent-level
accuracy and author-assigned difficulty *tags*; the per-task chart in the paper
is an image).

## Data source

HuggingFace dataset `harborframework/terminal-bench-2-leaderboard` — every
graded trial any submitter uploaded. Clone it (LFS-skipped; the `result.json`
files we need are plain text, not LFS) into the gitignored data dir:

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone \
  https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard \
  spell_harbor/data/tb2-leaderboard
```

Layout: `submissions/terminal-bench/2.0/<Agent>__<Model>/<run-ts>/<task>__<id>/result.json`.
Each leaf:

| field | meaning |
|---|---|
| `task_name` | e.g. `regex-chess` (sometimes prefixed `terminal-bench/`) |
| `agent_info.name` | agent scaffold (`terminus-2`, `forge`, …) |
| `agent_info.model_info.name` | model — **often blank**; resolved from `metadata.yaml` |
| `verifier_result.rewards.reward` | `0.0` \| `1.0` (1.0 == solved) |
| `exception_info` | `null` \| `{…}` — harness error, **excluded** from rates |

## Run

```bash
python3 analyze_leaderboard.py                 # console report
python3 analyze_leaderboard.py --top 30        # show 30 hardest/easiest
python3 analyze_leaderboard.py --json data/analysis.json --csv-dir data/csv
python3 analyze_leaderboard.py --task-filter dna   # restrict to matching tasks
```

Outputs (all gitignored under `data/`):
- `report.txt` — full console report
- `analysis.json` — machine-readable (tasks sorted by difficulty + raw tallies)
- `csv/tasks.csv`, `csv/models.csv`, `csv/task_model_matrix.csv`

## Two data-quality fixes the parser applies (don't skip these)

1. **Task-name normalization** — the `terminal-bench/` org prefix and
   `windows-3.11` vs `-3-11` are inconsistently present across submitters.
   Un-normalized, a single task splits into 2-3 keys → 180 phantom "tasks" and
   fake 0%/UNSOLVED rows with tiny *n*. Normalizing collapses to the true **89**.
2. **Model resolution** — ~60% of trials leave `agent_info.model_info.name`
   blank; the real model lives in the submission's `metadata.yaml` (`models:`
   list). The parser walks up to it and reads `model_name`; multi-model
   submissions become `Multiple`. This eliminates the giant `<unknown-model>`
   bucket that otherwise dominates the model table.

`attempted == 0` keys (pure naming phantoms) are filtered from every ranking and
export.

## Headline findings (21,229 trials · 18,432 scored · 2,797 harness-errored)

### Hardest tasks — lowest empirical pass rate across ALL models

| rank | task | pass-rate | solved/att | best model |
|---|---|---|---|---|
| 1 | `filter-js-from-html` | **3.4%** | 7/206 | claude-4.5-sonnet (one-off) |
| 2 | `make-doom-for-mips` | **7.1%** | 5/70 | — |
| 3 | `install-windows-3.11` | **10.1%** | 21/208 | claude-sonnet-4-6 (40%) |
| 4 | `sam-cell-seg` | **14.4%** | 33/229 | claude-opus-4-7 |
| 5 | `raman-fitting` | **14.9%** | 27/181 | — |
| 6 | `train-fasttext` | **18.9%** | 14/74 | — |
| 7 | `video-processing` | **23.6%** | 53/225 | gpt-5.4 |
| 8 | `caffe-cifar-10` | **31.0%** | 31/100 | — |
| 9 | `extract-moves-from-video` | **32.1%** | 36/112 | gpt-5.5 |
| 10 | `model-extraction-relu-logits` | **34.5%** | 70/203 | — |

Full ranked list: `data/csv/tasks.csv`.

**No task is solved by zero models** once trials are pooled across the full
submitter set — even `filter-js-from-html` has 7 passes. (The paper's
"unsolved" claim is per *their* fixed model set / Terminus-2 scaffold; the open
leaderboard includes stronger and more varied agents.) NB: `filter-js-from-html`
(3.4%, adversarial XSS-bypass) and the `make-doom-for-mips` /
`make-mips-interpreter` pair are the standouts that match the paper's
"empirically hard / creative-reasoning" cluster.

### Leaderboard — per model (all agents & tasks pooled)

| rank | model | pass-rate | n |
|---|---|---|---|
| 1 | gpt-5.4 | 87.8% | 400 |
| 2 | gpt-5.5 | 86.2% | 853 |
| 3 | sage-gpt-5.3-codex | 85.8% | 239 |
| 4 | Multiple (mixed-model subs) | 82.8% | 3440 |
| 5 | claude-opus-4.6 | 81.9% | 359 |
| 6 | gpt-5.3-codex | 81.4% | 2905 |
| 7 | gemini-3.1-pro-preview | 81.3% | 1511 |
| … | claude-sonnet-4-6 | 63.7% | 355 |
| … | deepseek-chat | 50.9% | 289 |
| … | TermiGen-32B | 27.6% | 283 |

Full list: `data/csv/models.csv`. NB: these are **pooled across all agent
scaffolds and submitters**, so they differ from the paper's single best-scaffold
numbers and from the official leaderboard's per-submission figures. Treat as the
aggregate empirical picture, not an official ranking.

### Caveats

- **Self-reported & uneven *n***. Submitters choose how many runs to upload;
  task coverage per model is uneven (n ranges from a handful to 200+). Low-n
  "100%" best-model cells are noise, not records.
- **Harness errors excluded.** 2,797 trials errored before scoring; they are
  counted separately (`errored` column) and never inflate or deflate a rate.
- **Open set ≠ paper set.** This pools every public submission (incl. post-paper
  models like GPT-5.4/5.5, Opus 4.6/4.7); the paper's Figure 11 uses a fixed
  model list under Terminus-2. Hardness *ordering* agrees; absolute numbers won't.
