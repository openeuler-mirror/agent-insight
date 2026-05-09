"""Shared visual constants and color helpers for SkillBench reports."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

from matplotlib import colormaps, colors

from ..config import (
    STATUS_AGENT_TIMEOUT,
    STATUS_ENV_TIMEOUT,
    STATUS_FAIL,
    STATUS_MISSING,
    STATUS_PARTIAL,
    STATUS_SETUP_TIMEOUT,
    STATUS_SUCCESS,
    Status,
)

GROUP_COLORS = {
    "init": "#ff7f0e",
    "static": "#1f77b4",
    "dynamic": "#2ca02c",
    "hybrid": "#d62728",
    "feedback": "#9467bd",
}

DEFAULT_GROUP_PALETTE = (
    "#1f77b4",
    "#ff7f0e",
    "#2ca02c",
    "#d62728",
    "#9467bd",
    "#8c564b",
    "#e377c2",
    "#7f7f7f",
    "#bcbd22",
    "#17becf",
)

MISSING_BG = "#f0f0f0"
MISSING_FG = "#777777"
AGENT_TIMEOUT_BG = "#42a5f5"
SETUP_TIMEOUT_BG = "#64b5f6"
ENV_TIMEOUT_BG = "#90caf9"
TIMEOUT_FG = "#111111"
FAIL_BG = "#ef9a9a"
FAIL_FG = "#111111"
BEST_BORDER = "2px solid #000000"


@dataclass(frozen=True)
class StyleSpec:
    declarations: tuple[tuple[str, str], ...]

    def as_css(self) -> tuple[str, ...]:
        return tuple(f"{key}: {value}" for key, value in self.declarations)

    def as_dict(self) -> dict[str, str]:
        return dict(self.declarations)


STATUS_STYLES: dict[Status, StyleSpec] = {
    Status.MISSING: StyleSpec((("background-color", MISSING_BG), ("color", MISSING_FG))),
    Status.AGENT_TIMEOUT: StyleSpec((("background-color", AGENT_TIMEOUT_BG), ("color", TIMEOUT_FG), ("font-weight", "600"))),
    Status.SETUP_TIMEOUT: StyleSpec((("background-color", SETUP_TIMEOUT_BG), ("color", TIMEOUT_FG), ("font-weight", "600"))),
    Status.ENV_TIMEOUT: StyleSpec((("background-color", ENV_TIMEOUT_BG), ("color", TIMEOUT_FG), ("font-weight", "600"))),
    Status.FAIL: StyleSpec((("background-color", FAIL_BG), ("color", FAIL_FG), ("font-weight", "600"))),
}

__all__ = [
    "AGENT_TIMEOUT_BG",
    "BEST_BORDER",
    "DEFAULT_GROUP_PALETTE",
    "ENV_TIMEOUT_BG",
    "FAIL_BG",
    "FAIL_FG",
    "GROUP_COLORS",
    "MISSING_BG",
    "MISSING_FG",
    "SETUP_TIMEOUT_BG",
    "STATUS_AGENT_TIMEOUT",
    "STATUS_ENV_TIMEOUT",
    "STATUS_FAIL",
    "STATUS_MISSING",
    "STATUS_PARTIAL",
    "STATUS_SETUP_TIMEOUT",
    "STATUS_STYLES",
    "STATUS_SUCCESS",
    "TIMEOUT_FG",
    "Status",
    "StyleSpec",
    "gradient_cmap",
    "gradient_description",
    "gradient_eligible_statuses",
    "group_colors",
    "relative_luminance",
    "soften_color",
    "text_color_for_background",
]


def group_colors(groups: list[str]) -> dict[str, str]:
    return {
        group: GROUP_COLORS.get(group, DEFAULT_GROUP_PALETTE[idx % len(DEFAULT_GROUP_PALETTE)])
        for idx, group in enumerate(groups)
    }


def gradient_cmap(metric: str) -> Any:
    return colormaps["RdYlGn" if metric == "success" else "RdYlGn_r"]


def gradient_eligible_statuses(metric: str) -> set[str]:
    if metric == "success":
        return {STATUS_SUCCESS, STATUS_PARTIAL}
    return {STATUS_SUCCESS, STATUS_PARTIAL, STATUS_FAIL}


def relative_luminance(hex_color: str) -> float:
    r, g, b = colors.to_rgb(hex_color)

    def linearize(channel: float) -> float:
        if channel <= 0.04045:
            return channel / 12.92
        return cast(float, ((channel + 0.055) / 1.055) ** 2.4)

    r_lin, g_lin, b_lin = linearize(r), linearize(g), linearize(b)
    return 0.2126 * r_lin + 0.7152 * g_lin + 0.0722 * b_lin


def text_color_for_background(bg_color: str) -> str:
    return "#ffffff" if relative_luminance(bg_color) < 0.33 else "#111111"


def soften_color(hex_color: str, blend: float = 0.55) -> str:
    r, g, b = colors.to_rgb(hex_color)
    r = r + (1.0 - r) * blend
    g = g + (1.0 - g) * blend
    b = b + (1.0 - b) * blend
    return colors.to_hex((r, g, b))


def gradient_description(metric: str) -> tuple[str, str, str]:
    if metric == "success":
        return (
            "lower success",
            "linear-gradient(90deg, #d73027 0%, #fee08b 50%, #1a9850 100%)",
            "higher success",
        )
    return (
        "lower is better",
        "linear-gradient(90deg, #1a9850 0%, #fee08b 50%, #d73027 100%)",
        "higher is worse",
    )
