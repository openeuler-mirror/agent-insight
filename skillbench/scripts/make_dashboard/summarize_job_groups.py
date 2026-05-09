#!/usr/bin/env python3
"""
Summarize SkillBench job groups in stdout tables.

Rules:
- Only include tasks that have at least one valid trial in all four groups:
  static, init, dynamic, hybrid.
- Skip invalid trials with zero token usage, including infra-failed trials.
- Compute per-group aggregate metrics over the remaining common tasks.

The script reads `result.json` files under:
  skillbench/jobs_<group>/<date_time>/<task_name>/result.json
"""

from __future__ import annotations

import argparse
from pathlib import Path
from statistics import StatisticsError, mean, median

from skillbench_lib.config import REQUIRED_GROUPS
from skillbench_lib.loaders import (
    collect_trials,
    find_common_tasks,
    find_common_tasks_for_groups,
    group_records_by_task_and_group,
)
from skillbench_lib.models import TrialRecord
from skillbench_lib.render.markdown import render_markdown_table
from skillbench_lib.render.palette import group_colors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Print summary tables for static/init/dynamic/hybrid SkillBench job groups, "
            "restricted to tasks present in all four groups."
        )
    )
    parser.add_argument(
        "--skillbench-root",
        default="skillbench",
        help="Path to the SkillBench root directory. Default: %(default)s",
    )
    parser.add_argument(
        "--show-task-table",
        action="store_true",
        help="Also print a per-task table grouped by static/init/dynamic/hybrid.",
    )
    parser.add_argument(
        "--format",
        choices=("text", "md"),
        default="text",
        help="Output format for tables. Default: %(default)s",
    )
    parser.add_argument(
        "--output",
        help="Optional output file path. Use a .md path with --format md.",
    )
    parser.add_argument(
        "--dashboard-output",
        help="Optional output HTML path for the Plotly task metrics dashboard.",
    )
    return parser.parse_args()


def _ordered_groups(records: list[TrialRecord]) -> list[str]:
    present_groups = {record.group for record in records}
    preferred = [group for group in REQUIRED_GROUPS if group in present_groups]
    extras = sorted(group for group in present_groups if group not in REQUIRED_GROUPS)
    return preferred + extras


def build_task_metrics_dashboard(records: list[TrialRecord]):
    try:
        import plotly.graph_objects as go
        from plotly.subplots import make_subplots
    except ImportError as exc:
        raise SystemExit(
            "Plotly is required for dashboard generation. Install it first, for example: `pip install plotly`."
        ) from exc

    groups = _ordered_groups(records)
    if not groups:
        raise ValueError("Cannot build dashboard: no groups found in records.")

    common_tasks = find_common_tasks_for_groups(records, groups)
    if not common_tasks:
        raise ValueError("Cannot build dashboard: no common tasks across all groups.")

    grouped = group_records_by_task_and_group(records, common_tasks)
    task_names = sorted(grouped)
    task_numbers = list(range(1, len(task_names) + 1))
    colors = group_colors(groups)

    metric_specs = [
        ("input_tokens", "Tokens Input", lambda rs: mean(r.input_tokens for r in rs)),
        ("output_tokens", "Tokens Output", lambda rs: mean(r.output_tokens for r in rs)),
        (
            "cost_usd",
            "Cost (USD)",
            lambda rs: mean(r.cost_usd for r in rs if r.cost_usd is not None),
        ),
        (
            "duration_sec",
            "Time (sec)",
            lambda rs: mean(r.duration_sec for r in rs if r.duration_sec is not None),
        ),
        (
            "success_rate",
            "Success Rate (%)",
            lambda rs: 100.0 * sum(r.success for r in rs) / len(rs),
        ),
    ]

    fig = make_subplots(
        rows=3,
        cols=2,
        subplot_titles=[label for _, label, _ in metric_specs],
        vertical_spacing=0.1,
        horizontal_spacing=0.08,
    )

    subplot_positions = [(1, 1), (1, 2), (2, 1), (2, 2), (3, 1)]
    for (metric_name, metric_label, aggregator), (row, col) in zip(metric_specs, subplot_positions):
        for group in groups:
            y_values: list[float | None] = []
            for task_name in task_names:
                group_records = grouped[task_name].get(group, [])
                if not group_records:
                    y_values.append(None)
                    continue
                try:
                    y_values.append(float(aggregator(group_records)))
                except StatisticsError:
                    y_values.append(None)

            fig.add_trace(
                go.Scatter(
                    x=task_numbers,
                    y=y_values,
                    mode="lines+markers",
                    name=group,
                    marker={"color": colors[group]},
                    line={"color": colors[group], "width": 2},
                    legendgroup=group,
                    showlegend=(metric_name == metric_specs[0][0]),
                    customdata=task_names,
                    hovertemplate=(
                        f"Mode=%{{fullData.name}}<br>Task #%{{x}}<br>Task=%{{customdata}}<br>{metric_label}=%{{y:.2f}}<extra></extra>"
                    ),
                ),
                row=row,
                col=col,
            )
        fig.update_xaxes(title_text="Task Number", row=row, col=col)
        fig.update_yaxes(title_text=metric_label, row=row, col=col)
        if metric_name == "success_rate":
            fig.update_yaxes(range=[0, 100], row=row, col=col)

    fig.update_xaxes(tickmode="array", tickvals=task_numbers)
    fig.update_layout(
        height=1200,
        width=1400,
        template="plotly_white",
        title="SkillBench Task Metrics Dashboard",
        legend_title_text="Mode",
        hovermode="x unified",
    )
    fig.update_annotations(font={"size": 14})
    return fig


def format_number(value: float | int | None, digits: int = 2) -> str:
    if value is None:
        return "-"
    if isinstance(value, int):
        return f"{value:,}"
    return f"{value:,.{digits}f}"


def render_table(headers: list[str], rows: list[list[str]]) -> str:
    widths = [len(header) for header in headers]
    for row in rows:
        for idx, cell in enumerate(row):
            widths[idx] = max(widths[idx], len(cell))

    def format_row(row: list[str]) -> str:
        return " | ".join(cell.ljust(widths[idx]) for idx, cell in enumerate(row))

    separator = "-+-".join("-" * width for width in widths)
    lines = [format_row(headers), separator]
    lines.extend(format_row(row) for row in rows)
    return "\n".join(lines)


def build_summary_rows(records: list[TrialRecord]) -> list[list[str]]:
    common_tasks = find_common_tasks(records)
    filtered = [record for record in records if record.task_name in common_tasks]

    rows: list[list[str]] = []
    for group in REQUIRED_GROUPS:
        group_records = [record for record in filtered if record.group == group]
        successes = sum(1 for record in group_records if record.success)
        success_rate = (100.0 * successes / len(group_records)) if group_records else None
        avg_total_tokens = mean(record.total_tokens for record in group_records) if group_records else None
        avg_output_tokens = mean(record.output_tokens for record in group_records) if group_records else None
        avg_cost = (
            mean(record.cost_usd for record in group_records if record.cost_usd is not None)
            if any(record.cost_usd is not None for record in group_records)
            else None
        )
        avg_duration = (
            mean(record.duration_sec for record in group_records if record.duration_sec is not None)
            if any(record.duration_sec is not None for record in group_records)
            else None
        )
        rows.append(
            [
                group,
                str(len(common_tasks)),
                str(len(group_records)),
                str(successes),
                format_number(success_rate),
                format_number(avg_total_tokens),
                format_number(avg_output_tokens),
                format_number(avg_cost, digits=4),
                format_number(avg_duration),
            ]
        )
    return rows


def summarize_task_records(records: list[TrialRecord]) -> list[list[str]]:
    common_tasks = find_common_tasks(records)
    grouped = group_records_by_task_and_group(records, common_tasks)
    rows: list[list[str]] = []

    for task_name in sorted(grouped):
        per_group = grouped[task_name]
        if any(group not in per_group for group in REQUIRED_GROUPS):
            continue

        task_row = [task_name]
        for group in REQUIRED_GROUPS:
            group_records = per_group[group]
            success_rate = 100.0 * sum(r.success for r in group_records) / len(group_records)
            avg_tokens = mean(r.total_tokens for r in group_records)
            avg_duration = (
                mean(r.duration_sec for r in group_records if r.duration_sec is not None)
                if any(r.duration_sec is not None for r in group_records)
                else None
            )
            task_row.extend(
                [
                    str(len(group_records)),
                    format_number(success_rate),
                    format_number(avg_tokens),
                    format_number(avg_duration),
                ]
            )
        rows.append(task_row)
    return rows


def build_summary_output(records: list[TrialRecord], show_task_table: bool, output_format: str) -> str:
    common_tasks = find_common_tasks(records)
    filtered_records = [record for record in records if record.task_name in common_tasks]
    table_renderer = render_markdown_table if output_format == "md" else render_table
    lines: list[str] = []

    if output_format == "md":
        lines.append("# SkillBench Job Group Summary")
        lines.append("")
        lines.append(f"- Valid trials scanned: {len(records)}")
        lines.append(f"- Common tasks across static/init/dynamic/hybrid: {len(common_tasks)}")
        lines.append(f"- Trials used for summary: {len(filtered_records)}")
        lines.append("")
        lines.append("## Group Summary")
        lines.append("")
    else:
        lines.append(f"Valid trials scanned: {len(records)}")
        lines.append(f"Common tasks across static/init/dynamic/hybrid: {len(common_tasks)}")
        lines.append(f"Trials used for summary: {len(filtered_records)}")
        lines.append("")

    summary_headers = [
        "group",
        "common_tasks",
        "trials",
        "successes",
        "success_rate_%",
        "avg_total_tokens",
        "avg_output_tokens",
        "avg_cost_usd",
        "avg_duration_sec",
    ]
    lines.append(table_renderer(summary_headers, build_summary_rows(records)))

    if show_task_table:
        lines.append("")
        if output_format == "md":
            lines.append("## Per-Task Comparison")
            lines.append("")
        task_headers = [
            "task",
            "static_trials",
            "static_success_%",
            "static_avg_tokens",
            "static_avg_duration",
            "init_trials",
            "init_success_%",
            "init_avg_tokens",
            "init_avg_duration",
            "dynamic_trials",
            "dynamic_success_%",
            "dynamic_avg_tokens",
            "dynamic_avg_duration",
            "hybrid_trials",
            "hybrid_success_%",
            "hybrid_avg_tokens",
            "hybrid_avg_duration",
        ]
        lines.append(table_renderer(task_headers, summarize_task_records(records)))

        med_headers = [
            "group",
            "median_total_tokens",
            "median_output_tokens",
            "median_duration_sec",
        ]
        med_rows = []
        for group in REQUIRED_GROUPS:
            group_records = [record for record in filtered_records if record.group == group]
            med_rows.append(
                [
                    group,
                    format_number(median(record.total_tokens for record in group_records) if group_records else None),
                    format_number(median(record.output_tokens for record in group_records) if group_records else None),
                    format_number(
                        median(record.duration_sec for record in group_records if record.duration_sec is not None)
                        if any(record.duration_sec is not None for record in group_records)
                        else None
                    ),
                ]
            )
        lines.append("")
        if output_format == "md":
            lines.append("## Median Usage")
            lines.append("")
        lines.append(table_renderer(med_headers, med_rows))

    return "\n".join(lines) + "\n"


def main() -> int:
    args = parse_args()
    skillbench_root = Path(args.skillbench_root).resolve()
    if not skillbench_root.exists():
        raise SystemExit(f"SkillBench root does not exist: {skillbench_root}")

    records = collect_trials(skillbench_root)
    if not records:
        raise SystemExit("No valid nonzero-token trials found.")

    output = build_summary_output(
        records,
        show_task_table=args.show_task_table,
        output_format=args.format,
    )

    if args.output:
        output_path = Path(args.output).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output, encoding="utf-8")
    else:
        print(output, end="")

    if args.dashboard_output:
        dashboard_path = Path(args.dashboard_output).resolve()
        dashboard_path.parent.mkdir(parents=True, exist_ok=True)
        dashboard = build_task_metrics_dashboard(records)
        dashboard.write_html(
            dashboard_path,
            include_plotlyjs="cdn",
            full_html=True,
        )
        print(f"Wrote dashboard to {dashboard_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
