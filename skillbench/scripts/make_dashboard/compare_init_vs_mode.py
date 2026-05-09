#!/usr/bin/env python3
"""
Compare init against each optimized SkillBench mode on their pairwise task overlap.

For each mode in {static, dynamic, hybrid}, the script:
- restricts analysis to tasks present in both init and that mode
- computes aggregate metrics for init and the mode over the pairwise overlap
- computes paired per-task deltas for success, tokens, duration, output tokens, and cost
- writes a markdown report and a 3-panel Plotly dashboard
- writes a one-line-per-mode summary markdown file
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from statistics import mean, median

from skillbench_lib.classify import has_agent_timeout
from skillbench_lib.config import BASELINE_GROUP, COMPARISON_GROUPS
from skillbench_lib.loaders import (
    collect_trials,
    find_common_tasks_for_groups,
    group_records_by_task_and_group,
)
from skillbench_lib.models import TrialRecord
from skillbench_lib.render.markdown import render_markdown_table
from skillbench_lib.render.palette import GROUP_COLORS


@dataclass
class AggregateStats:
    n_tasks: int
    n_trials: int
    success_rate_micro: float | None
    success_rate_macro: float | None
    mean_total_tokens: float | None
    mean_output_tokens: float | None
    tokens_per_success: float | None
    mean_agent_execution_sec: float | None
    mean_cost_usd: float | None


@dataclass
class TaskMetrics:
    success_rate: float
    mean_total_tokens: float
    mean_output_tokens: float
    mean_duration_sec: float | None
    mean_cost_usd: float | None
    n_trials: int


@dataclass
class DeltaSummary:
    mean: float | None
    median: float | None
    wins: int
    ties: int
    losses: int


@dataclass
class PairwiseSummary:
    mode: str
    common_tasks: list[str]
    chart_tasks: list[str]
    aggregate_by_group: dict[str, AggregateStats]
    task_metrics: dict[str, dict[str, TaskMetrics]]
    delta_success: DeltaSummary
    delta_total_tokens: DeltaSummary
    delta_duration_sec: DeltaSummary
    low_confidence: bool


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare init against each optimized SkillBench mode on pairwise-overlap tasks."
    )
    parser.add_argument(
        "--skillbench-root",
        default="skillbench",
        help="Path to the SkillBench root directory. Default: %(default)s",
    )
    parser.add_argument(
        "--output-dir",
        default="skillbench/plots/pairwise",
        help="Directory for generated markdown and HTML files. Default: %(default)s",
    )
    return parser.parse_args()


def format_number(value: float | int | None, digits: int = 2, signed: bool = False) -> str:
    if value is None:
        return "-"
    if isinstance(value, int):
        return f"{value:+,}" if signed else f"{value:,}"
    prefix = "+" if signed else ""
    return f"{value:{prefix},.{digits}f}"


def format_delta_percent(value: float | None) -> str:
    return format_number(value, digits=2, signed=True) if value is not None else "-"


def format_plot_hover_value(metric_name: str, value: float | None) -> str:
    if value is None:
        return "-"
    if metric_name == "success_rate":
        return f"{value:.2f}"
    if metric_name in {"mean_cost_usd", "mean_cost_usd_joint_success"}:
        return f"{value:.4f}"
    return f"{value:.2f}"


def sort_key_for_metric(summary: PairwiseSummary, task_name: str, metric_name: str) -> tuple[float, float, str]:
    init_value = metric_plot_value(summary, task_name, BASELINE_GROUP, metric_name)
    mode_value = metric_plot_value(summary, task_name, summary.mode, metric_name)
    init_value = 0.0 if init_value is None else float(init_value)
    mode_value = 0.0 if mode_value is None else float(mode_value)

    if metric_name == "success_rate":
        improvement = init_value - mode_value
        absolute_scale = init_value
    else:
        absolute_scale = max(init_value, mode_value)
        improvement = (init_value - mode_value) / max(absolute_scale, 1e-9)

    return (improvement, absolute_scale, task_name)


def metric_plot_value(summary: PairwiseSummary, task_name: str, group: str, metric_name: str) -> float | None:
    metrics = summary.task_metrics[task_name][group]
    if metric_name == "mean_cost_usd_joint_success":
        return metrics.mean_cost_usd
    return getattr(metrics, metric_name)


def tasks_for_metric(summary: PairwiseSummary, metric_name: str) -> list[str]:
    if metric_name != "mean_cost_usd_joint_success":
        return summary.chart_tasks
    return [
        task_name
        for task_name in summary.chart_tasks
        if summary.task_metrics[task_name][BASELINE_GROUP].success_rate > 0.0
        and summary.task_metrics[task_name][summary.mode].success_rate > 0.0
    ]


def task_level_metrics(records: list[TrialRecord]) -> TaskMetrics:
    durations = [record.duration_sec for record in records if record.duration_sec is not None]
    costs = [record.cost_usd for record in records if record.cost_usd is not None]
    return TaskMetrics(
        success_rate=100.0 * sum(record.success for record in records) / len(records),
        mean_total_tokens=mean(record.total_tokens for record in records),
        mean_output_tokens=mean(record.output_tokens for record in records),
        mean_duration_sec=mean(durations) if durations else None,
        mean_cost_usd=mean(costs) if costs else None,
        n_trials=len(records),
    )


def should_exclude_from_chart(init_records: list[TrialRecord], mode_records: list[TrialRecord]) -> bool:
    return has_agent_timeout(init_records) and has_agent_timeout(mode_records)


def aggregate_group_stats(grouped: dict[str, dict[str, list[TrialRecord]]], group: str) -> AggregateStats:
    group_records = [record for task_name in grouped for record in grouped[task_name][group]]
    per_task_success = [task_level_metrics(grouped[task_name][group]).success_rate for task_name in grouped]
    durations = [record.duration_sec for record in group_records if record.duration_sec is not None]
    costs = [record.cost_usd for record in group_records if record.cost_usd is not None]
    successes = sum(record.success for record in group_records)
    total_tokens = sum(record.total_tokens for record in group_records)
    return AggregateStats(
        n_tasks=len(grouped),
        n_trials=len(group_records),
        success_rate_micro=(100.0 * successes / len(group_records)) if group_records else None,
        success_rate_macro=mean(per_task_success) if per_task_success else None,
        mean_total_tokens=mean(record.total_tokens for record in group_records) if group_records else None,
        mean_output_tokens=mean(record.output_tokens for record in group_records) if group_records else None,
        tokens_per_success=(total_tokens / successes) if successes else None,
        mean_agent_execution_sec=mean(durations) if durations else None,
        mean_cost_usd=mean(costs) if costs else None,
    )


def summarize_deltas(values: list[float], *, lower_is_better: bool) -> DeltaSummary:
    wins = 0
    ties = 0
    losses = 0
    for value in values:
        if value == 0:
            ties += 1
        elif lower_is_better:
            if value < 0:
                wins += 1
            else:
                losses += 1
        else:
            if value > 0:
                wins += 1
            else:
                losses += 1
    return DeltaSummary(
        mean=mean(values) if values else None,
        median=median(values) if values else None,
        wins=wins,
        ties=ties,
        losses=losses,
    )


def build_pairwise_summary(records: list[TrialRecord], mode: str) -> PairwiseSummary:
    pair_tasks = find_common_tasks_for_groups(records, (BASELINE_GROUP, mode))
    grouped = group_records_by_task_and_group(records, pair_tasks)
    filtered_grouped = {
        task_name: per_group
        for task_name, per_group in grouped.items()
        if BASELINE_GROUP in per_group and mode in per_group
    }

    task_metrics: dict[str, dict[str, TaskMetrics]] = {}
    success_deltas: list[float] = []
    token_deltas: list[float] = []
    duration_deltas: list[float] = []
    chart_tasks: list[str] = []

    for task_name in sorted(filtered_grouped):
        init_records = filtered_grouped[task_name][BASELINE_GROUP]
        mode_records = filtered_grouped[task_name][mode]
        task_metrics[task_name] = {
            BASELINE_GROUP: task_level_metrics(init_records),
            mode: task_level_metrics(mode_records),
        }
        if not should_exclude_from_chart(init_records, mode_records):
            chart_tasks.append(task_name)
        success_deltas.append(task_metrics[task_name][mode].success_rate - task_metrics[task_name][BASELINE_GROUP].success_rate)
        token_deltas.append(task_metrics[task_name][mode].mean_total_tokens - task_metrics[task_name][BASELINE_GROUP].mean_total_tokens)
        mode_duration = task_metrics[task_name][mode].mean_duration_sec
        init_duration = task_metrics[task_name][BASELINE_GROUP].mean_duration_sec
        if mode_duration is not None and init_duration is not None:
            duration_deltas.append(mode_duration - init_duration)

    aggregate_by_group = {
        BASELINE_GROUP: aggregate_group_stats(filtered_grouped, BASELINE_GROUP),
        mode: aggregate_group_stats(filtered_grouped, mode),
    }

    return PairwiseSummary(
        mode=mode,
        common_tasks=sorted(filtered_grouped),
        chart_tasks=chart_tasks,
        aggregate_by_group=aggregate_by_group,
        task_metrics=task_metrics,
        delta_success=summarize_deltas(success_deltas, lower_is_better=False),
        delta_total_tokens=summarize_deltas(token_deltas, lower_is_better=True),
        delta_duration_sec=summarize_deltas(duration_deltas, lower_is_better=True),
        low_confidence=len(filtered_grouped) < 5,
    )


def build_aggregate_rows(summary: PairwiseSummary) -> list[list[str]]:
    rows: list[list[str]] = []
    for group in (BASELINE_GROUP, summary.mode):
        stats = summary.aggregate_by_group[group]
        rows.append(
            [
                group,
                str(stats.n_tasks),
                str(stats.n_trials),
                format_number(stats.success_rate_micro),
                format_number(stats.success_rate_macro),
                format_number(stats.mean_total_tokens),
                format_number(stats.mean_output_tokens),
                format_number(stats.tokens_per_success),
                format_number(stats.mean_agent_execution_sec),
                format_number(stats.mean_cost_usd, digits=4),
            ]
        )
    return rows


def build_delta_rows(summary: PairwiseSummary) -> list[list[str]]:
    return [
        [
            "success_rate_pct_points",
            format_delta_percent(summary.delta_success.mean),
            format_delta_percent(summary.delta_success.median),
            f"{summary.delta_success.wins}/{summary.delta_success.ties}/{summary.delta_success.losses}",
            "higher",
        ],
        [
            "mean_total_tokens",
            format_number(summary.delta_total_tokens.mean, signed=True),
            format_number(summary.delta_total_tokens.median, signed=True),
            f"{summary.delta_total_tokens.wins}/{summary.delta_total_tokens.ties}/{summary.delta_total_tokens.losses}",
            "lower",
        ],
        [
            "mean_duration_sec",
            format_number(summary.delta_duration_sec.mean, signed=True),
            format_number(summary.delta_duration_sec.median, signed=True),
            f"{summary.delta_duration_sec.wins}/{summary.delta_duration_sec.ties}/{summary.delta_duration_sec.losses}",
            "lower",
        ],
    ]


def build_task_rows(summary: PairwiseSummary) -> list[list[str]]:
    rows: list[list[str]] = []
    for task_name in summary.common_tasks:
        init_metrics = summary.task_metrics[task_name][BASELINE_GROUP]
        mode_metrics = summary.task_metrics[task_name][summary.mode]
        duration_delta = (
            mode_metrics.mean_duration_sec - init_metrics.mean_duration_sec
            if mode_metrics.mean_duration_sec is not None and init_metrics.mean_duration_sec is not None
            else None
        )
        rows.append(
            [
                task_name,
                str(init_metrics.n_trials),
                format_number(init_metrics.success_rate),
                format_number(init_metrics.mean_total_tokens),
                format_number(init_metrics.mean_output_tokens),
                format_number(init_metrics.mean_duration_sec),
                str(mode_metrics.n_trials),
                format_number(mode_metrics.success_rate),
                format_number(mode_metrics.mean_total_tokens),
                format_number(mode_metrics.mean_output_tokens),
                format_number(mode_metrics.mean_duration_sec),
                format_delta_percent(mode_metrics.success_rate - init_metrics.success_rate),
                format_number(mode_metrics.mean_total_tokens - init_metrics.mean_total_tokens, signed=True),
                format_number(duration_delta, signed=True),
            ]
        )
    return rows


def render_markdown_report(summary: PairwiseSummary) -> str:
    lines: list[str] = []
    lines.append(f"# Init vs {summary.mode.capitalize()}")
    lines.append("")
    lines.append(f"- Pair: `init` vs `{summary.mode}`")
    lines.append(f"- Common tasks in pair: {len(summary.common_tasks)}")
    lines.append(
        f"- Tasks shown in charts: {len(summary.chart_tasks)} "
        f"(excluded {len(summary.common_tasks) - len(summary.chart_tasks)} tasks where both agents timed out at 900.x sec)"
    )
    lines.append(
        f"- Confidence: {'low-confidence' if summary.low_confidence else 'normal'}"
    )
    lines.append("- Caveat: sample sizes are small; this report is descriptive only and makes no significance claims.")
    lines.append("")
    lines.append("## Aggregate Metrics")
    lines.append("")
    lines.append(
        render_markdown_table(
            [
                "group",
                "n_tasks",
                "n_trials",
                "success_rate_micro_%",
                "success_rate_macro_%",
                "mean_total_tokens",
                "mean_output_tokens",
                "tokens_per_success",
                "mean_agent_execution_sec",
                "mean_cost_usd",
            ],
            build_aggregate_rows(summary),
        )
    )
    lines.append("")
    lines.append("## Paired Delta Summary")
    lines.append("")
    lines.append(
        render_markdown_table(
            ["metric", "mean_delta", "median_delta", "wins/ties/losses", "better_direction"],
            build_delta_rows(summary),
        )
    )
    lines.append("")
    lines.append("## Per-Task Comparison")
    lines.append("")
    lines.append(
        render_markdown_table(
            [
                "task",
                "init_trials",
                "init_success_%",
                "init_mean_tokens",
                "init_mean_output_tokens",
                "init_mean_duration_sec",
                f"{summary.mode}_trials",
                f"{summary.mode}_success_%",
                f"{summary.mode}_mean_tokens",
                f"{summary.mode}_mean_output_tokens",
                f"{summary.mode}_mean_duration_sec",
                "delta_success_pp",
                "delta_tokens",
                "delta_duration_sec",
            ],
            build_task_rows(summary),
        )
    )
    lines.append("")
    return "\n".join(lines)


def write_dashboard(summary: PairwiseSummary, output_path: Path, chart_type: str) -> None:
    try:
        import plotly.graph_objects as go
        from plotly.subplots import make_subplots
    except ImportError as exc:
        raise SystemExit("Plotly is required for this script. Install it first, for example: `pip install plotly`.") from exc

    if chart_type not in {"bar", "line"}:
        raise ValueError(f"Unsupported chart type: {chart_type}")

    metric_specs = [
        ("success_rate", "Success Rate (%)", "success_rate"),
        ("mean_total_tokens", "Mean Total Tokens", "mean_total_tokens"),
        ("mean_duration_sec", "Mean Duration (sec)", "mean_duration_sec"),
        ("mean_cost_usd", "Mean Cost (USD)", "mean_cost_usd"),
        ("mean_cost_usd_joint_success", "Mean Cost (USD, jointly solved tasks)", "mean_cost_usd"),
    ]
    fig = make_subplots(
        rows=2,
        cols=3,
        subplot_titles=[spec[1] for spec in metric_specs],
        horizontal_spacing=0.08,
        vertical_spacing=0.14,
    )

    for index, spec in enumerate(metric_specs, start=1):
        metric_name = spec[0]
        metric_label = spec[1]
        sort_metric_name = spec[2] if len(spec) > 2 else metric_name
        row = 1 if index <= 3 else 2
        col = ((index - 1) % 3) + 1
        metric_tasks = tasks_for_metric(summary, metric_name)
        ordered_tasks = sorted(
            metric_tasks,
            key=lambda task_name: sort_key_for_metric(summary, task_name, sort_metric_name),
            reverse=True,
        )
        for group in (BASELINE_GROUP, summary.mode):
            y_values: list[float] = []
            hover_values: list[str] = []
            for task_name in ordered_tasks:
                value = metric_plot_value(summary, task_name, group, metric_name)
                hover_values.append(format_plot_hover_value(metric_name, None if value is None else float(value)))
                y_values.append(0.0 if value is None else float(value))
            if chart_type == "bar":
                trace = go.Bar(
                    name=group,
                    x=ordered_tasks,
                    y=y_values,
                    marker_color=GROUP_COLORS[group],
                    legendgroup=group,
                    showlegend=(index == 1),
                    customdata=hover_values,
                    hovertemplate=(
                        "group=%{fullData.name}<br>"
                        "task=%{x}<br>"
                        f"{metric_label}=%{{customdata}}<extra></extra>"
                    ),
                )
            else:
                trace = go.Scatter(
                    name=group,
                    x=ordered_tasks,
                    y=y_values,
                    mode="lines+markers",
                    marker={"color": GROUP_COLORS[group], "size": 7},
                    line={"color": GROUP_COLORS[group], "width": 3},
                    legendgroup=group,
                    showlegend=(index == 1),
                    customdata=hover_values,
                    hovertemplate=(
                        "group=%{fullData.name}<br>"
                        "task=%{x}<br>"
                        f"{metric_label}=%{{customdata}}<extra></extra>"
                    ),
                )
            fig.add_trace(trace, row=row, col=col)
        fig.update_xaxes(title_text="Task Name", tickangle=-25, row=row, col=col)
        fig.update_yaxes(title_text=metric_label, row=row, col=col)
        if metric_name == "success_rate":
            fig.update_yaxes(range=[0, 100], row=row, col=col)

    title_suffix = " (low-confidence)" if summary.low_confidence else ""
    chart_label = "Bar Charts" if chart_type == "bar" else "Line Charts"
    fig.update_layout(
        title=(
            f"Init vs {summary.mode.capitalize()} {chart_label}{title_suffix}"
            f"<br><sup>Charts exclude tasks where both groups timed out at 900.x sec</sup>"
        ),
        template="plotly_white",
        legend_title_text="Group",
        height=1000,
        width=2200,
        hovermode="x unified",
    )
    if chart_type == "bar":
        fig.update_layout(barmode="group")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.write_html(output_path, include_plotlyjs="cdn", full_html=True)


def write_summary_markdown(summaries: list[PairwiseSummary], output_path: Path) -> None:
    rows = []
    for summary in summaries:
        rows.append(
            [
                summary.mode,
                str(len(summary.common_tasks)),
                format_delta_percent(summary.delta_success.mean),
                format_number(summary.delta_total_tokens.mean, signed=True),
                format_number(summary.delta_duration_sec.mean, signed=True),
                f"{summary.delta_success.wins}/{summary.delta_success.ties}/{summary.delta_success.losses}",
                "low-confidence" if summary.low_confidence else "normal",
            ]
        )

    content = "\n".join(
        [
            "# Pairwise Init Comparison Summary",
            "",
            "- Caveat: sample sizes are small; this report is descriptive only and makes no significance claims.",
            "",
            render_markdown_table(
                [
                    "mode",
                    "n_tasks",
                    "delta_success_mean_pp",
                    "delta_tokens_mean",
                    "delta_duration_mean_sec",
                    "success_wins/ties/losses",
                    "confidence",
                ],
                rows,
            ),
            "",
        ]
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(content, encoding="utf-8")


def main() -> int:
    args = parse_args()

    skillbench_root = Path(args.skillbench_root).resolve()
    if not skillbench_root.exists():
        raise SystemExit(f"SkillBench root does not exist: {skillbench_root}")

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    records = collect_trials(skillbench_root)
    if not records:
        raise SystemExit("No valid nonzero-token trials found.")

    summaries: list[PairwiseSummary] = []
    for mode in COMPARISON_GROUPS:
        summary = build_pairwise_summary(records, mode)
        summaries.append(summary)

        md_path = output_dir / f"init_vs_{mode}.md"
        md_path.write_text(render_markdown_report(summary), encoding="utf-8")
        print(f"Wrote {md_path}")

        bar_html_path = output_dir / f"init_vs_{mode}.html"
        write_dashboard(summary, bar_html_path, chart_type="bar")
        print(f"Wrote {bar_html_path}")

        line_html_path = output_dir / f"init_vs_{mode}_lines.html"
        write_dashboard(summary, line_html_path, chart_type="line")
        print(f"Wrote {line_html_path}")

    summary_path = output_dir / "summary.md"
    write_summary_markdown(summaries, summary_path)
    print(f"Wrote {summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
