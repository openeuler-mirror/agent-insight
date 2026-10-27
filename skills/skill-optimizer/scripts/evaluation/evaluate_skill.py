# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from langchain_openai import ChatOpenAI

try:
    from .prompts import PROMPT_SKILL_META, PROMPT_CODE_QUALITY
    from .utils import check_environment_variables, format_header
except ImportError:
    from prompts import PROMPT_SKILL_META, PROMPT_CODE_QUALITY
    from utils import check_environment_variables, format_header


def load_file_content(file_path: Path) -> str:
    if not file_path.is_file():
        logging.warning(f"文件未找到: {file_path}")
        return ""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        logging.error(f"读取文件时发生错误 {file_path}: {e}")
        return ""


def load_directory_content(dir_path: Path) -> str:
    if not dir_path.is_dir():
        logging.warning(f"目录未找到: {dir_path}")
        return ""

    all_content: List[str] = []
    for file_path in dir_path.rglob("*"):
        if file_path.is_file():
            logging.info(f"正在读取 reference 文件: {file_path.name}")
            content = load_file_content(file_path)
            all_content.append(f"--- 文件: {file_path.name} ---\n{content}\n")

    return "\n".join(all_content)


def _coerce_llm_response_text(resp: Any) -> str:
    content_str = getattr(resp, "content", None)
    if isinstance(content_str, str):
        return content_str
    return str(resp)


def call_deepseek_api(prompt: str, content: str) -> Dict[str, Any] | None:
    if not content.strip():
        logging.warning("评估内容为空，跳过 API 调用。")
        return None

    final_prompt = prompt.format(content=content)
    max_retries = 3

    llm = ChatOpenAI(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
        base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/"),
        api_key=os.getenv("DEEPSEEK_API_KEY"),
        max_retries=max_retries,
    )

    response = llm.invoke(final_prompt)
    content_str = _coerce_llm_response_text(response)
    return {"choices": [{"message": {"content": content_str}}]}


def _strip_markdown_code_fence(s: str) -> str:
    cleaned = (s or "").strip()
    if not cleaned.startswith("```"):
        return cleaned

    first_newline = cleaned.find("\n")
    if first_newline != -1:
        cleaned = cleaned[first_newline + 1 :]

    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]

    return cleaned.strip()


def parse_evaluation_response(
    response: Dict[str, Any] | str | None,
) -> Tuple[List[Dict[str, Any]], str]:
    if not response:
        return [], ""

    if isinstance(response, str):
        content_str = response
    else:
        content_str = (
            response.get("choices", [{}])[0].get("message", {}).get("content", "{}")
        )

    try:
        cleaned_content = _strip_markdown_code_fence(content_str)
        evaluation_data = json.loads(cleaned_content.strip())
        detailed_evaluation = evaluation_data.get("detailed_evaluation", [])
        overall_comment = evaluation_data.get("overall_comment", "")
        if not isinstance(detailed_evaluation, list):
            detailed_evaluation = []
        if not isinstance(overall_comment, str):
            overall_comment = str(overall_comment)
        return detailed_evaluation, overall_comment
    except (json.JSONDecodeError, IndexError, KeyError) as e:
        logging.error(f"解析评估响应时出错: {e}")
        logging.error(f"收到的原始响应内容: {content_str}")
        return [], ""


def compute_evaluation_scores(results: List[Dict[str, Any]]) -> Tuple[float, List[Dict[str, Any]]]:
    valid_scores: List[float] = []
    for item in results:
        score_val = item.get("score", 0)
        try:
            float_score = float(score_val)
            item["score"] = float_score
            valid_scores.append(float_score)
        except (ValueError, TypeError):
            pass

    total_score = sum(valid_scores)
    average_score = total_score / len(valid_scores) if valid_scores else 0
    dimension_order = [
        "职责与触发",
        "结构与效率",
        "指令粒度",
        "内容一致性",
        "风险管控",
        "代码质量",
    ]
    sorted_results = sorted(
        results,
        key=lambda x: (
            dimension_order.index(x.get("dimension"))
            if x.get("dimension") in dimension_order
            else 99
        ),
    )
    return average_score, sorted_results


def build_evaluation_report(
    skill_name: str,
    average_score: float,
    meta_comment: str,
    code_comment: str,
    sorted_results: List[Dict[str, Any]],
) -> str:
    report_lines: List[str] = []
    report_lines.append(format_header(f"Skill 综合评估报告: {skill_name}", width=60))
    report_lines.append(f"\n[ 最终平均分 ]: {average_score:.1f} / 5.0")
    report_lines.append(f"[ Skill评估总结 ]: {meta_comment}")
    report_lines.append(f"[ 代码质量评估总结 ]: {code_comment}")
    report_lines.append("\n--- 各维度详细评分 ---\n")
    for item in sorted_results:
        dimension = item.get("dimension", "未知维度")
        score = item.get("score", "N/A")
        justification = item.get("justification", "无理由")
        report_lines.append(f"  - {dimension}: {score}/5")
        report_lines.append(f"    理由: {justification}\n")
    return "\n".join(report_lines)


def save_report(skill_name: str, report_content: str) -> None:
    reports_dir_env = os.getenv("EVALUATION_REPORT_DIR")
    if reports_dir_env:
        reports_dir = Path(reports_dir_env)
    else:
        reports_dir = Path(__file__).parent / "reports"

    reports_dir.mkdir(exist_ok=True, parents=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_filename = f"{skill_name}_{timestamp}.txt"
    report_path = reports_dir / report_filename

    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report_content)
    logging.info(f"评估报告已成功保存到: {report_path}")


def evaluate_single_skill(skill_dir: Path) -> None:
    logging.info(f"--- 开始评估 Skill: {skill_dir.name} ---")

    if not skill_dir.is_dir():
        logging.error(f"错误: 提供的路径不是一个目录 -> {skill_dir}")
        return

    logging.info(f"[{skill_dir.name}] 阶段 1: 评估 Skill 元数据 (SKILL.md)")
    skill_md_path = next(skill_dir.glob("[Ss][Kk][Ii][Ll][Ll].[Mm][Dd]"), None)
    if not skill_md_path:
        logging.error(f"错误: 在 {skill_dir} 中未找到 SKILL.md 或 skill.md 文件。")
        return

    skill_meta_content = load_file_content(skill_md_path)
    meta_response = call_deepseek_api(PROMPT_SKILL_META, skill_meta_content)
    meta_results, meta_comment = parse_evaluation_response(meta_response)

    logging.info(f"[{skill_dir.name}] 阶段 2: 评估代码质量 (references)")
    references_path = skill_dir / "references"
    scripts_path = skill_dir / "scripts"
    reference_content = load_directory_content(references_path)
    code_content = load_directory_content(scripts_path)
    code_response = call_deepseek_api(PROMPT_CODE_QUALITY, reference_content + code_content)
    code_results, code_comment = parse_evaluation_response(code_response)

    logging.info(f"[{skill_dir.name}] 阶段 3: 生成综合评估报告")
    all_results = meta_results + code_results

    average_score, sorted_results = compute_evaluation_scores(all_results)
    report_content = build_evaluation_report(
        skill_name=skill_dir.name,
        average_score=average_score,
        meta_comment=meta_comment,
        code_comment=code_comment,
        sorted_results=sorted_results,
    )

    logging.info(report_content)
    save_report(skill_dir.name, report_content)


class SkillEvaluator:
    def __init__(self, llm: Any):
        self.llm = llm

    def evaluate_meta(
        self, content: str, trace_id: Optional[str] = None
    ) -> Tuple[List[Dict[str, Any]], str]:
        final_prompt = PROMPT_SKILL_META.format(content=content)
        resp = self.llm.invoke(final_prompt)
        text = _coerce_llm_response_text(resp)
        results, comment = parse_evaluation_response(text)
        dim_map = {
            "职责与触发": "职责明确性",
            "结构与效率": "结构规范性",
            "指令粒度": "指令适配性",
            "内容一致性": "内容一致性",
            "风险管控": "风险可控性",
        }
        for item in results:
            dim = item.get("dimension")
            if isinstance(dim, str) and dim in dim_map:
                item["dimension"] = dim_map[dim]
        return results, comment


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    check_environment_variables(
        ["DEEPSEEK_API_KEY", "EVALUATION_SKILL_PATH", "EVALUATION_REPORT_DIR"]
    )

    skill_path_str = os.environ.get("EVALUATION_SKILL_PATH")
    skill_path = Path(skill_path_str).expanduser().resolve()

    if not skill_path.exists():
        raise SystemExit(f"错误: 提供的路径不存在 -> {skill_path}")

    skill_dirs_to_evaluate: List[Path] = []
    if (
        skill_path.is_dir()
        and next(skill_path.glob("[Ss][Kk][Ii][Ll][Ll].[Mm][Dd]"), None) is not None
    ):
        skill_dirs_to_evaluate.append(skill_path)
    elif skill_path.is_dir():
        for sub_dir in skill_path.iterdir():
            if sub_dir.is_dir() and next(
                sub_dir.glob("[Ss][Kk][Ii][Ll][Ll].[Mm][Dd]"), None
            ):
                skill_dirs_to_evaluate.append(sub_dir)

    if not skill_dirs_to_evaluate:
        logging.warning(f"在路径 {skill_path} 下未找到任何有效的 Skill 目录。")
        return

    logging.info(f"找到 {len(skill_dirs_to_evaluate)} 个 Skill 待评估。")
    for skill_dir in skill_dirs_to_evaluate:
        evaluate_single_skill(skill_dir)


if __name__ == "__main__":
    main()
