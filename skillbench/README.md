# SkillBench

Benchmarking platform for evaluating AI skill effectiveness. Runs tasks via [Harbor](https://github.com/laude-institute/harbor), collects metrics (tokens, cost, duration, success rate) and compares results before and after skill optimization across four modes: **static**, **dynamic**, **hybrid**, **feedback**.

## Requirements

- Python >= 3.12
- [uv](https://docs.astral.sh/uv/) (package manager)
- Docker (to run tasks via Harbor)
- Running [Witty Skill Insight](../README.md) instance on `localhost:3000`

## Configuration model

`scripts/pipeline_launch/run_pipeline.sh` is **`.env`-driven**: there are no CLI flags and no in-script default values. Every variable below must be set in `skillbench/.env` (the script fails via `set -u` if anything is missing).

| Variable | Purpose |
|---|---|
| `MODEL` | Model passed to harbor (e.g. `deepseek/deepseek-v3.2`) |
| `AGENT` | Agent name (e.g. `opencode`) |
| `START_STEP`, `END_STEP` | Step range to run, `1..6` (`START_STEP <= END_STEP`) |
| `MODES` | Space-separated optimization modes (subset of `static dynamic hybrid feedback`) |
| `TASKS_INIT_DIR` | Path to prepared tasks (typically `${BASE_DIR}/tasks_init`) |
| `MAX_PARALLEL` | Max parallel harbor tasks for steps 1 and 6 |
| `RUNS` | Number of runs per task batch (steps 1 and 6) |
| `<MODEL>_API_KEY` | Provider key matching `MODEL`'s prefix (e.g. `DEEPSEEK_API_KEY` for `deepseek/*`). See `scripts/check_api_keys.sh` for the mapping. |
| `SKILL_INSIGHT_BASE_URL` | Witty service URL used by `import_skills.sh` |

`BASE_DIR` is auto-detected from the script's location and exported before `.env` is sourced — `.env` may interpolate it (e.g. `TASKS_INIT_DIR=${BASE_DIR}/tasks_init`) but should not redefine it.

## Quick Start

End-to-end minimal run from a clean checkout:

```bash
# 1. Start Witty Skill Insight (from the project root, one level up)
cd ..
bash scripts/restart_dev.sh         # serves on http://localhost:3000

# 2. Configure SkillBench
cd skillbench
cp .env.example .env                # set MODEL, AGENT, MODES, API keys, etc.
uv sync

# 3. Download the full task catalog into ./tasks/
uv run scripts/download_skillbench.py

# 4. Pick which tasks to benchmark
$EDITOR witty-integration/benchmark_tasks.yaml   # comment out tasks you don't want

# 5. Configure the Witty integration credentials used inside task containers
cp witty-integration/.env.template witty-integration/.env
$EDITOR witty-integration/.env                   # SKILL_INSIGHT_API_KEY

# 6. Prepare tasks_init/ from the selection (copies from tasks/ + injects opencode integration)
bash witty-integration/prepare-benchmark-tasks.sh

# 7. Run the full pipeline (init baseline -> extract/import skills -> optimize per mode -> re-run)
bash scripts/pipeline_launch/run_pipeline.sh

# 8. Generate the analysis dashboard for the latest run
bash scripts/make_dashboard/run_analysis.sh
```

To smoke-test on a smaller scope, narrow `witty-integration/benchmark_tasks.yaml` and/or set `MODES="dynamic"` (or any single mode) and `MAX_PARALLEL=2` in `.env`.

### Run directory layout

Every pipeline invocation writes its outputs into a single timestamped run directory:

```
skillbench/runs/<YYYYMMDD_HHMMSS>/
  jobs_init/
  skills_init/
  skills_optimized-<mode>/
  tasks_<mode>/
  jobs_<mode>/
  logs/
    init_run<N>.log               # main log of step 1
    init_run<N>/<task>.log        # per-task harbor stdout/stderr
    <mode>.log                    # log of steps 4 + 5 for a mode
    <mode>_run<N>.log             # main log of step 6 for a mode
    <mode>_run<N>/<task>.log      # per-task harbor stdout/stderr
    import_skills_<ts>.log        # log of step 3
```

`skillbench/runs/latest` is a symlink to the most recent run; it is updated only **after step 1 completes**, so a failed-very-early run won't replace a usable previous one.

## Pipeline

`scripts/pipeline_launch/run_pipeline.sh` runs a 6-step cycle. Each step can be skipped via `START_STEP` / `END_STEP` in `.env`, but a fresh run dir is always created (no resume mechanism).

```
Step 1: Run initial tasks                    (run_tasks_parallel_final.sh on tasks_init/)
   |
Step 2: Extract skills from tasks            (extract_skills_info.py)
   |
Step 3: Import skills into Witty             (import_skills.sh)
   |
Step 4: Optimize skills per mode             (skill-optimizer/scripts/main_parallel.py)
   |
Step 5: Create new task sets per mode        (create_tasks_mode.py)
   |
Step 6: Run tasks with optimized skills      (run_tasks_parallel_final.sh on tasks_<mode>/)
```

Steps 4–6 iterate over each mode in `MODES`. A mode that fails step 4 or 5 is skipped (the loop `continue`s); other modes proceed independently.

### Calling individual stages directly

For debugging you can run any sub-script standalone — they are not coupled to `run_pipeline.sh` other than through directory conventions.

```bash
# Step 1 / 6: parallel harbor execution
bash scripts/run_tasks_parallel_final.sh tasks_init  runs/latest/jobs_init  deepseek/deepseek-v3.2  3  opencode
# Optional: LOG_DIR env var redirects per-task stdout/stderr away from skillbench/logs/
LOG_DIR=runs/latest/logs/init_run1 bash scripts/run_tasks_parallel_final.sh ...

# Step 2: extract baseline skills
uv run scripts/extract_skills_info.py tasks_init runs/latest/skills_init

# Step 3: import into Witty (optional 2nd arg redirects log location)
bash scripts/import_skills.sh runs/latest/skills_init runs/latest/logs

# Step 5: build tasks_<mode>/ from optimized skills
uv run scripts/create_tasks_mode.py tasks_init runs/latest/skills_optimized-static \
    --dest-dir runs/latest/tasks_static
```

### Step 7. Analysis (separate from `run_pipeline.sh`)

Analysis is cheap compared to running the benchmark: it only reads existing `jobs_init/`, `jobs_<mode>/` result files in a run dir and regenerates reports under that run dir's `plots/`.

```bash
# Default: analyze runs/latest
bash scripts/make_dashboard/run_analysis.sh

# Or analyze a specific run dir
bash scripts/make_dashboard/run_analysis.sh runs/20260430_174110
```

Or run individual report generators:

```bash
uv run python3 scripts/make_dashboard/summarize_job_groups.py \
  --skillbench-root runs/latest \
  --format md \
  --show-task-table \
  --output runs/latest/plots/job_group_summary.md

uv run python3 scripts/make_dashboard/compare_init_vs_mode.py \
  --skillbench-root runs/latest \
  --output-dir runs/latest/plots/pairwise

uv run python3 scripts/make_dashboard/task_mode_tables.py \
  --skillbench-root runs/latest \
  --output-dir runs/latest/plots/tables
```

Generated outputs (under `runs/<run>/plots/`):

| Path | Description |
|------|-------------|
| `job_group_summary.md` | Strict four-way summary for common tasks across init/static/dynamic/hybrid |
| `pairwise/summary.md` | Pairwise init-vs-mode summary |
| `pairwise/init_vs_<mode>.html` | Bar-chart dashboard for init vs one optimized mode |
| `pairwise/init_vs_<mode>_lines.html` | Line-chart dashboard for init vs one optimized mode |
| `tables/index.html` | Entry point for per-task × per-mode HTML tables |
| `tables/{success,tokens,duration,cost,cost_per_1m}.html` | Color-coded metric tables |
| `tables/aggregate.html` | Aggregate metrics by mode |

Open the generated `.html` files directly in a browser. No dev server is required for viewing the reports.

---

## File Structure

### Configuration

| File | Description |
|------|-------------|
| `pyproject.toml` | Project metadata, dependencies (harbor, ruff, mypy), linter settings |
| `.env.example` | Template for `.env` |
| `.env` | Local file with API keys and pipeline config (not committed) |
| `.python-version` | Python version for uv/pyenv (3.12) |
| `uv.lock` | Dependency lock file |

### Pipeline scripts (`scripts/`)

| File | Used in step | Description |
|------|---|---|
| `download_skillbench.py` | setup | Downloads tasks from the SkillsBench GitHub repo via sparse-checkout |
| `run_tasks_parallel_final.sh` | 1, 6 | Parallel harbor execution. Reads optional `LOG_DIR` env var for per-task logs |
| `extract_skills_info.py` | 2 | Extracts skill folders from `environment/skills/` of each task; writes `extraction_info.json` |
| `import_skills.sh` | 3 | Imports skills into Witty via REST API; optional 2nd arg sets log dir |
| `create_tasks_mode.py` | 5 | Creates `tasks_{mode}/` — task copies with skills replaced by optimized versions |
| `check_api_keys.sh` | sourced | Maps `MODEL` to its required API-key env var (`api_key_var_for_model`) and asserts the var is set (`require_api_key`) |
| `lib/docker.sh` | sourced | `docker_cleanup` helper |
| `lib/modes.sh` | sourced | Canonical mode list and `validate_mode` helper |

### Analysis scripts (`scripts/make_dashboard/`)

| File | Description |
|------|-------------|
| `summarize_job_groups.py` | Aggregates metrics across 4 groups (init/static/dynamic/hybrid), builds summary tables |
| `compare_init_vs_mode.py` | Pairwise comparison of baseline (init) vs each optimized mode with deltas and charts |
| `task_mode_tables.py` | HTML/Markdown tables of tasks × modes with color gradients and status indicators |
| `run_analysis.sh` | Runs the analysis suite over a run dir (defaults to `runs/latest`) |

### Orchestration (`scripts/pipeline_launch/`)

| File | Description |
|------|-------------|
| `run_pipeline.sh` | End-to-end driver, configured entirely via `.env`. Iterates steps in `[START_STEP..END_STEP]` and modes in `MODES` |

### Witty Integration (`witty-integration/`)

| File | Description |
|------|-------------|
| `.env.template` | Environment variable template for connecting to Witty from a Docker container |
| `benchmark_tasks.yaml` | Manifest: list of benchmark tasks with source paths |
| `Dockerfile.template` | Dockerfile fragment appended to each task for Witty setup |
| `opencode-integration.sh` | Installs the Witty OpenCode plugin inside a task container |
| `prepare-benchmark-tasks.sh` | Copies tasks from `tasks/` (catalog) into `tasks_init/` and injects Witty integration |

### Data (generated, not committed)

| Directory | Description |
|-----------|-------------|
| `tasks/` | Full task catalog downloaded from SkillsBench |
| `tasks_init/` | Tasks with Witty integration prepared for the next run |
| `runs/<YYYYMMDD_HHMMSS>/` | One pipeline invocation's outputs (`jobs_init`, `skills_init`, `skills_optimized-<mode>`, `tasks_<mode>`, `jobs_<mode>`, `logs`, `plots`) |
| `runs/latest` | Symlink to the most recently completed run dir |
