#!/usr/bin/env python3
"""
Render per-task x per-mode metric tables with status-aware coloring.

Outputs:
- HTML tables with legends and column-wise gradients.
- Markdown tables with compact status markers.
"""

from __future__ import annotations

import argparse
import os
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from statistics import quantiles

os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib")

from matplotlib import colors

from skillbench_lib.classify import classify_cell, is_timeout_duration
from skillbench_lib.config import MODES
from skillbench_lib.loaders import collect_trial_artifacts, parse_all_task_names
from skillbench_lib.models import CellState, TrialArtifact
from skillbench_lib.render.html_table import Table, TableCell, render_table_html, render_table_markdown, render_template
from skillbench_lib.render.palette import (
    AGENT_TIMEOUT_BG,
    BEST_BORDER,
    ENV_TIMEOUT_BG,
    MISSING_BG,
    SETUP_TIMEOUT_BG,
    STATUS_STYLES,
    Status,
    gradient_cmap,
    gradient_description,
    soften_color,
    text_color_for_background,
)

BASE_CELL_STYLE = {
    "padding": "6px 10px",
    "text-align": "center",
    "white-space": "nowrap",
}


@dataclass(frozen=True)
class Metric:
    key: str
    title: str
    cell_attr: str
    fmt: Callable[[float | None], str]
    higher_is_better: bool
    gradient_statuses: frozenset[Status]

    def value(self, cell: CellState) -> float | None:
        return getattr(cell, self.cell_attr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render per-task x per-mode SkillBench metric tables."
    )
    parser.add_argument(
        "--skillbench-root",
        default="skillbench",
        help="Path to the SkillBench root directory. Default: %(default)s",
    )
    parser.add_argument(
        "--output-dir",
        default="skillbench/plots/tables",
        help="Directory for generated HTML and markdown tables. Default: %(default)s",
    )
    return parser.parse_args()


def format_percent(value: float | None) -> str:
    if value is None:
        return "-"
    percent = 100.0 * value
    if abs(percent - round(percent)) < 0.05:
        return f"{round(percent):.0f}%"
    return f"{percent:.1f}%"


def format_tokens(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{round(value):,}"


def format_duration(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:.2f}s"


def format_cost(value: float | None) -> str:
    if value is None:
        return "-"
    return f"${value:.4f}"


def format_cost_per_1m(value: float | None) -> str:
    if value is None:
        return "-"
    return f"${value:.4f} / 1M"


METRICS = (
    Metric("success", "Success Rate", "success_rate", format_percent, True, frozenset({Status.SUCCESS, Status.PARTIAL})),
    Metric(
        "tokens",
        "Total Tokens",
        "mean_tokens",
        format_tokens,
        False,
        frozenset({Status.SUCCESS, Status.PARTIAL, Status.FAIL}),
    ),
    Metric(
        "duration",
        "Agent Execution Duration",
        "mean_duration",
        format_duration,
        False,
        frozenset({Status.SUCCESS, Status.PARTIAL, Status.FAIL}),
    ),
    Metric("cost", "Cost", "mean_cost", format_cost, False, frozenset({Status.SUCCESS, Status.PARTIAL, Status.FAIL})),
    Metric(
        "cost_per_1m",
        "Cost per 1M Tokens",
        "mean_cost_per_1M",
        format_cost_per_1m,
        False,
        frozenset({Status.SUCCESS, Status.PARTIAL, Status.FAIL}),
    ),
)

TIMEOUT_HTML_LABELS = {
    Status.AGENT_TIMEOUT: "agent timeout",
    Status.SETUP_TIMEOUT: "setup timeout",
    Status.ENV_TIMEOUT: "env timeout",
}
TIMEOUT_MARKDOWN_LABELS = {
    Status.AGENT_TIMEOUT: "agent-timeout",
    Status.SETUP_TIMEOUT: "setup-timeout",
    Status.ENV_TIMEOUT: "env-timeout",
}
TIMEOUT_MARKDOWN_SUFFIXES = {
    Status.AGENT_TIMEOUT: "agent",
    Status.SETUP_TIMEOUT: "setup",
    Status.ENV_TIMEOUT: "env",
}


def format_html_cell(cell: CellState, metric: Metric) -> str:
    status = Status(cell.status)
    if status == Status.MISSING:
        return "-"

    if metric.key == "success":
        if status in TIMEOUT_HTML_LABELS:
            return TIMEOUT_HTML_LABELS[status]
        return metric.fmt(metric.value(cell))

    text = metric.fmt(metric.value(cell))
    if status in TIMEOUT_HTML_LABELS:
        label = TIMEOUT_HTML_LABELS[status]
        return f"{text} ({label})" if text != "-" else label
    return text


def format_markdown_cell(cell: CellState, metric: Metric) -> str:
    status = Status(cell.status)
    if status == Status.MISSING:
        return "—"

    if metric.key == "success":
        if status in TIMEOUT_MARKDOWN_LABELS:
            return f"⏱ {TIMEOUT_MARKDOWN_LABELS[status]}"
        text = metric.fmt(metric.value(cell))
        return f"{text} ✗" if status == Status.FAIL else text

    text = metric.fmt(metric.value(cell))
    if status in TIMEOUT_MARKDOWN_SUFFIXES:
        suffix = TIMEOUT_MARKDOWN_SUFFIXES[status]
        return f"{text} ⏱{suffix}" if text != "-" else f"⏱ {TIMEOUT_MARKDOWN_LABELS[status]}"
    if status == Status.FAIL:
        return f"{text} ✗"
    return text


def build_grid(skillbench_root: Path) -> tuple[list[str], dict[tuple[str, str], CellState]]:
    records = collect_trial_artifacts(skillbench_root, MODES)
    bucket: dict[tuple[str, str], list[TrialArtifact]] = defaultdict(list)
    tasks = sorted({record.task_name for record in records} | set(parse_all_task_names(skillbench_root, MODES)))
    for record in records:
        bucket[(record.task_name, record.group)].append(record)

    grid: dict[tuple[str, str], CellState] = {}
    for task in tasks:
        for mode in MODES:
            grid[(task, mode)] = classify_cell(bucket.get((task, mode), []))
    return tasks, grid


def build_best_cells(
    grid: dict[tuple[str, str], CellState],
    tasks: list[str],
    metric: Metric,
) -> set[tuple[str, str]]:
    best_cells: set[tuple[str, str]] = set()
    for task in tasks:
        candidates: list[tuple[str, float]] = []
        for mode in MODES:
            cell = grid[(task, mode)]
            if Status(cell.status) not in {Status.SUCCESS, Status.PARTIAL}:
                continue
            value = metric.value(cell)
            if value is not None:
                candidates.append((mode, value))
        if not candidates:
            continue
        best_mode = (
            max(candidates, key=lambda item: (item[1], -MODES.index(item[0])))
            if metric.higher_is_better
            else min(candidates, key=lambda item: (item[1], MODES.index(item[0])))
        )[0]
        best_cells.add((task, best_mode))
    return best_cells


def build_gradient_colors(
    grid: dict[tuple[str, str], CellState],
    tasks: list[str],
    metric: Metric,
) -> dict[tuple[str, str], str]:
    cmap = gradient_cmap(metric.key)
    color_map: dict[tuple[str, str], str] = {}

    for task in tasks:
        values: list[float] = []
        for mode in MODES:
            cell = grid[(task, mode)]
            value = metric.value(cell)
            if Status(cell.status) in metric.gradient_statuses and value is not None:
                values.append(float(value))

        if not values:
            continue

        vmin = min(values)
        vmax = max(values)
        if abs(vmax - vmin) < 1e-12:
            normalizer = None
        else:
            normalizer = colors.Normalize(vmin=vmin, vmax=vmax)

        for mode in MODES:
            cell = grid[(task, mode)]
            value = metric.value(cell)
            if Status(cell.status) not in metric.gradient_statuses or value is None:
                continue
            ratio = 0.5 if normalizer is None else float(normalizer(float(value)))
            color_map[(task, mode)] = soften_color(colors.to_hex(cmap(ratio)))

    return color_map


def cell_style(
    cell: CellState,
    gradient_colors: dict[tuple[str, str], str],
    best_cells: set[tuple[str, str]],
    metric: Metric,
    task: str,
    mode: str,
) -> dict[str, str]:
    status = Status(cell.status)
    style = dict(BASE_CELL_STYLE)

    # FAIL is colored only on the success-rate table; otherwise it falls
    # through so the gradient can paint it.
    status_style = STATUS_STYLES.get(status)
    if status == Status.FAIL and metric.key != "success":
        status_style = None

    if status_style is not None:
        style.update(status_style.as_dict())
    elif (task, mode) in gradient_colors:
        bg_color = gradient_colors[(task, mode)]
        style.update(
            {
                "background-color": bg_color,
                "color": text_color_for_background(bg_color),
            }
        )

    style["border"] = BEST_BORDER if (task, mode) in best_cells else "1px solid #dddddd"
    return style


def render_legend(metric: Metric) -> str:
    left_label, gradient_css, right_label = gradient_description(metric.key)
    fail_item = ""
    if metric.key == "success":
        fail_item = """
        <div class="legend-item">
          <span class="swatch" style="background:#ef9a9a;"></span>
          <span>fail</span>
        </div>
        """
    return render_template(
        "legend.html",
        missing_bg=MISSING_BG,
        agent_timeout_bg=AGENT_TIMEOUT_BG,
        setup_timeout_bg=SETUP_TIMEOUT_BG,
        env_timeout_bg=ENV_TIMEOUT_BG,
        fail_item=fail_item,
        left_label=left_label,
        gradient_css=gradient_css,
        right_label=right_label,
    )


def build_metric_table(
    grid: dict[tuple[str, str], CellState],
    tasks: list[str],
    metric: Metric,
    *,
    markdown: bool,
) -> Table:
    gradient_colors = build_gradient_colors(grid, tasks, metric)
    best_cells = build_best_cells(grid, tasks, metric)
    rows: list[list[TableCell]] = []
    formatter = format_markdown_cell if markdown else format_html_cell

    for task in tasks:
        row = [TableCell(task, header=True, class_name="task-cell")]
        for mode in MODES:
            cell = grid[(task, mode)]
            row.append(
                TableCell(
                    formatter(cell, metric),
                    style={} if markdown else cell_style(cell, gradient_colors, best_cells, metric, task, mode),
                )
            )
        rows.append(row)

    return Table(
        headers=("task", *MODES),
        rows=rows,
        caption=metric.title,
        class_name="data-table metric-table",
    )


def page_html(title: str, body: str) -> str:
    css = render_template("styles.css")
    return render_template("page.html", title=title, css=css, body=body)


def write_html_table(table: Table, metric: Metric, output_path: Path) -> None:
    body = f"""
  <div class="nav"><a href="index.html">Back to index</a></div>
  <h1>{metric.title}</h1>
  <p class="meta">Rows are tasks. Columns are modes. Missing or infra-only cells render as "-", timeout cells are split into agent/setup/environment variants, and the best mode in each row gets a black border.</p>
  {render_legend(metric)}
  <div class="table-wrap">
    {render_table_html(table)}
  </div>
"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(page_html(f"{metric.title} Table", body), encoding="utf-8")


def write_markdown_table(table: Table, metric: Metric, output_path: Path) -> None:
    content = (
        f"# {metric.title}\n\n"
        "- `—` means missing.\n"
        "- `⏱agent`, `⏱setup`, `⏱env` mark timeout type.\n"
        "- `✗` marks fail.\n\n"
        + render_table_markdown(table)
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(content, encoding="utf-8")


def write_index(output_dir: Path) -> None:
    links = "\n".join(
        f'<li><a href="{metric.key}.html">{metric.title}</a> | <a href="{metric.key}.md">markdown</a></li>'
        for metric in METRICS
    )
    body = f"""
  <h1>Task x Mode Metric Tables</h1>
  <p>One table per metric, with status-aware coloring and per-row best-mode markers.</p>
  <div class="legend-note">
    Missing cells are gray, timeout cells are split into agent/setup/environment variants, success-rate failures are red, and successful or partial cells use a column-wise gradient.
  </div>
  <ul>
    <li><a href="aggregate.html">Aggregate Metrics by Mode</a> | <a href="aggregate.md">markdown</a></li>
    {links}
  </ul>
"""
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "index.html").write_text(page_html("Task x Mode Tables", body), encoding="utf-8")


AGGREGATE_METRICS = (
    ("cost", "Cost", "cost"),
    ("tokens", "Total Tokens", "tokens"),
    ("input_tokens", "Input Tokens", "tokens"),
    ("duration", "Duration", "duration"),
)


def _quantiles_or_single(values: list[float]) -> tuple[float, float, float] | None:
    if not values:
        return None
    if len(values) == 1:
        v = values[0]
        return (v, v, v)
    q25, q50, q75 = quantiles(values, n=4, method="inclusive")
    return (q25, q50, q75)


def _format_agg_value(metric_key: str, value: float) -> str:
    if metric_key == "cost":
        return format_cost(value)
    if metric_key in ("tokens", "input_tokens"):
        return format_tokens(value)
    if metric_key == "duration":
        return format_duration(value)
    raise ValueError(metric_key)


def compute_aggregate(
    records: list[TrialArtifact],
) -> dict[str, dict[str, object]]:
    """Return {mode: {metric: (q25, q50, q75) | sr float | None}}."""
    bucket: dict[str, list[TrialArtifact]] = {mode: [] for mode in MODES}
    for rec in records:
        if rec.group in bucket:
            bucket[rec.group].append(rec)

    out: dict[str, dict[str, object]] = {}
    for mode, recs in bucket.items():
        valid = [r for r in recs if r.total_tokens > 0]
        pool = valid

        mode_out: dict[str, object] = {}
        mode_out["success_rate"] = (
            (sum(1 for r in valid if r.success) / len(valid)) if valid else None
        )
        mode_out["n_total"] = len(valid)
        mode_out["n_completed"] = sum(1 for r in valid if r.success)

        mode_out["n_agent_timeout"] = sum(
            1 for r in valid
            if r.exception_type == "AgentTimeoutError"
            or (r.exception_type is None and is_timeout_duration(r.duration_sec))
        )

        costs = [r.cost_usd for r in pool if r.cost_usd is not None]
        tokens = [float(r.total_tokens) for r in pool]
        input_tokens = [float(r.input_tokens) for r in pool]
        durations = [r.duration_sec for r in pool if r.duration_sec is not None]

        mode_out["cost"] = _quantiles_or_single(costs)
        mode_out["tokens"] = _quantiles_or_single(tokens)
        mode_out["input_tokens"] = _quantiles_or_single(input_tokens)
        mode_out["duration"] = _quantiles_or_single(durations)
        out[mode] = mode_out
    return out


def find_common_tasks(records: list[TrialArtifact]) -> set[str]:
    per_mode: dict[str, set[str]] = {mode: set() for mode in MODES}
    for r in records:
        if r.group in per_mode and r.total_tokens > 0:
            per_mode[r.group].add(r.task_name)
    if not all(per_mode.values()):
        return set()
    return set.intersection(*per_mode.values())


def aggregate_headers() -> tuple[str, ...]:
    headers = ["metric"]
    for mode in MODES:
        headers.extend([f"{mode} Q25", f"{mode} Q50", f"{mode} Q75"])
    return tuple(headers)


def aggregate_header_rows() -> tuple[tuple[TableCell, ...], tuple[TableCell, ...]]:
    mode_header = tuple(TableCell(mode, header=True, class_name="mode-head", colspan=3) for mode in MODES)
    quantile_header = tuple(TableCell(label, header=True, class_name="quantile-head") for _ in MODES for label in ("Q25", "Q50", "Q75"))
    return (
        (TableCell("metric", header=True, class_name="metric-head", rowspan=2), *mode_header),
        quantile_header,
    )


def build_aggregate_table(data: dict[str, dict[str, object]]) -> Table:
    rows: list[list[TableCell]] = []

    for key, title, _ in AGGREGATE_METRICS:
        row = [TableCell(title, header=True, class_name="metric-cell")]
        for mode in MODES:
            q = data[mode][key]
            row.extend(TableCell("-") for _ in range(3) if q is None)
            if q is not None:
                row.extend(TableCell(_format_agg_value(key, value)) for value in q)
        rows.append(row)

    timeout_row = [TableCell("agent timeout errors", header=True, class_name="metric-cell")]
    for mode in MODES:
        n = data[mode]["n_agent_timeout"]
        denom = data[mode]["n_total"]
        text = f"{n} / {denom}" if denom else "-"
        timeout_row.extend(TableCell(text, class_name="sr-cell") for _ in range(3))
    rows.append(timeout_row)

    success_row = [TableCell("success rate", header=True, class_name="metric-cell")]
    for mode in MODES:
        sr = data[mode]["success_rate"]
        n_total = data[mode]["n_total"]
        n_done = data[mode]["n_completed"]
        text = "-" if sr is None else f"{format_percent(sr)} ({n_done}/{n_total})"
        success_row.extend(TableCell(text, class_name="sr-cell") for _ in range(3))
    rows.append(success_row)

    return Table(
        headers=aggregate_headers(),
        header_rows=aggregate_header_rows(),
        rows=rows,
        class_name="data-table agg-table",
    )


def aggregate_sections(records: list[TrialArtifact]) -> tuple[Table, Table | None, int]:
    data_all = compute_aggregate(records)
    common = find_common_tasks(records)
    records_common = [r for r in records if r.task_name in common]
    return build_aggregate_table(data_all), (build_aggregate_table(compute_aggregate(records_common)) if common else None), len(common)


def write_aggregate_table(records: list[TrialArtifact], output_path: Path) -> None:
    table_all, table_common, common_count = aggregate_sections(records)
    if table_common is not None:
        common_section = f"""
  <h2 class="section">Common tasks only <span class="n">(N = {common_count} tasks)</span></h2>
  <p class="note">Restricted to tasks that have a valid (non-zero-token) trial in every mode. Denominators are aligned across modes.</p>
  {render_table_html(table_common)}"""
    else:
        common_section = """
  <h2 class="section">Common tasks only</h2>
  <p class="note">No tasks are valid in all four modes.</p>"""

    body = f"""
  <div class="nav"><a href="index.html">Back to index</a></div>
  <h1>Aggregate Metrics by Mode</h1>

  <h2 class="section">All valid trials</h2>
  <p class="note">Quantiles (Q25/Q50/Q75) are computed across trials. All rows use the same denominator: trials with non-zero tokens (infra-only failures are excluded). Denominators may differ across modes because each mode ran a slightly different set of tasks.</p>
  {render_table_html(table_all)}
{common_section}
"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(page_html("Aggregate Metrics", body), encoding="utf-8")


def write_aggregate_markdown(records: list[TrialArtifact], output_path: Path) -> None:
    table_all, table_common, common_count = aggregate_sections(records)

    lines: list[str] = ["# Aggregate Metrics by Mode", ""]
    lines.append("## All valid trials")
    lines.append("")
    lines.append(render_table_markdown(table_all))
    lines.append("")

    if table_common is not None:
        lines.append(f"## Common tasks only (N = {common_count} tasks)")
        lines.append("")
        lines.append(render_table_markdown(table_common))
        lines.append("")
    else:
        lines.append("## Common tasks only")
        lines.append("")
        lines.append("_No tasks are valid in all four modes._")
        lines.append("")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    skillbench_root = Path(args.skillbench_root).resolve()
    output_dir = Path(args.output_dir).resolve()

    if not skillbench_root.exists():
        raise SystemExit(f"SkillBench root does not exist: {skillbench_root}")

    tasks, grid = build_grid(skillbench_root)

    for metric in METRICS:
        write_html_table(build_metric_table(grid, tasks, metric, markdown=False), metric, output_dir / f"{metric.key}.html")
        print(f"Wrote {output_dir / f'{metric.key}.html'}")

        write_markdown_table(build_metric_table(grid, tasks, metric, markdown=True), metric, output_dir / f"{metric.key}.md")
        print(f"Wrote {output_dir / f'{metric.key}.md'}")

    records = collect_trial_artifacts(skillbench_root, MODES)
    write_aggregate_table(records, output_dir / "aggregate.html")
    print(f"Wrote {output_dir / 'aggregate.html'}")
    write_aggregate_markdown(records, output_dir / "aggregate.md")
    print(f"Wrote {output_dir / 'aggregate.md'}")

    write_index(output_dir)
    print(f"Wrote {output_dir / 'index.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
