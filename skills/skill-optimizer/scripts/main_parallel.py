import argparse
import concurrent.futures
import datetime
import logging
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional

import httpx
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI

# Add project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from architecture.genome import SkillGenome
from constants import ENV_FILE
from engine.report_generator import OptimizationReportGenerator
from optimizer import SkillOptimizer
from skill_insight_api import get_skill_logs
from cli_args import CliArgsError, resolve_human_feedback_content

# Configure main process logging
logging.basicConfig(
    level=logging.INFO,
    format="\033[94m%(asctime)s - [MAIN] - %(levelname)s - %(message)s\033[0m",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# --- LLM Client Setup ---
class RealLLMClient:
    def __init__(self):
        # 优先检查 DEEPSEEK 配置
        deepseek_api_key = os.getenv("DEEPSEEK_API_KEY")
        openai_api_key = os.getenv("OPENAI_API_KEY")

        if deepseek_api_key:
            # 使用 DeepSeek 配置
            base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/")
            model_name = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
            api_key = deepseek_api_key
        elif openai_api_key:
            # 使用 OpenAI 配置
            base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
            model_name = os.getenv("OPENAI_MODEL", "gpt-4")
            api_key = openai_api_key
        else:
            from constants import ENV_FILE

            raise ValueError(
                f"\n❌ Error: Neither DEEPSEEK_API_KEY nor OPENAI_API_KEY is set.\n"
                f"Please configure your AI model API key in the environment file:\n"
                f"   -> {ENV_FILE.absolute()}\n"
                f"Alternatively, you can run './scripts/opt.sh --help' to use the interactive setup."
            )

        self.llm = ChatOpenAI(
            model=model_name,
            base_url=base_url,
            api_key=api_key,
            http_client=httpx.Client(verify=False, timeout=300.0),
            http_async_client=httpx.AsyncClient(verify=False, timeout=300.0),
            max_tokens=8192,
            request_timeout=300.0,
        )

    def __call__(self, prompt):
        logger.info(f"\n[RealLLM] Sending Prompt (truncated): {prompt[:100]}...")
        try:
            response = self.llm.invoke(prompt)
            if hasattr(response, "content"):
                return response.content
            return str(response)
        except Exception as e:
            logger.error(f"[RealLLM] Error: {e}")
            return ""


# --- Core Logic Functions ---


def validate_skill_file(file_path: Path) -> tuple[bool, str]:
    """
    验证 SKILL.md 文件的完整性

    Returns:
        (is_valid, error_message)
    """
    if not file_path.exists():
        return False, f"文件不存在: {file_path}"

    content = file_path.read_text(encoding="utf-8")
    if not content or len(content) < 100:
        return False, f"文件内容过短: {len(content)} 字符"

    if not content.startswith("---"):
        return False, "缺少 YAML frontmatter"

    frontmatter_match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not frontmatter_match:
        return False, "frontmatter 格式错误"

    frontmatter = frontmatter_match.group(1)
    if "name:" not in frontmatter:
        return False, "frontmatter 缺少 name 字段"

    return True, ""


def validate_auxiliary_file(file_path: Path) -> tuple[bool, str]:
    """
    验证辅助文件的完整性

    Returns:
        (is_valid, error_message)
    """
    if not file_path.exists():
        return False, f"文件不存在: {file_path}"

    content = file_path.read_text(encoding="utf-8")
    if not content or len(content.strip()) == 0:
        return False, f"文件内容为空: {file_path}"

    return True, ""


def sanitize_reference_content(content: str) -> str:
    content = content or ""
    content = re.sub(
        r"\[([^\]]+)\]\(((?:scripts|references)/[^)]+)\)",
        r"\1 (`\2`)",
        content,
        flags=re.IGNORECASE,
    )
    return content


def update_skill_name_in_md(content: str, new_name: str) -> str:
    """Update skill name in SKILL.md content."""
    # Try YAML frontmatter first
    pattern = r"^name:\s+(.+)$"
    match = re.search(pattern, content, re.MULTILINE)
    if match:
        return re.sub(
            pattern, f"name: {new_name}", content, count=1, flags=re.MULTILINE
        )

    # Fallback to header (only if name is in header)
    pattern = r"^#\s+(.+)$"
    match = re.search(pattern, content, re.MULTILINE)
    if match:
        return re.sub(pattern, f"# {new_name}", content, count=1, flags=re.MULTILINE)

    return content


def integrate_auxiliary_references(
    skill_content: str,
    auxiliary_files: dict[str, str],
    auxiliary_meta: Optional[dict[str, str]] = None,
) -> str:
    """
    在 SKILL.md 中自动添加对辅助文件的引用

    Args:
        skill_content: SKILL.md 的内容
        auxiliary_files: 辅助文件字典 {相对路径: 内容}
        auxiliary_meta: 辅助文件元数据 {相对路径: summary}

    Returns:
        更新后的 SKILL.md 内容
    """
    if not auxiliary_files:
        return skill_content

    auxiliary_meta = auxiliary_meta or {}
    section_heading_re = re.compile(
        r"(?im)^\s*##\s*(辅助文件|相关文件|auxiliary files|related files)\s*$"
    )
    has_section = bool(section_heading_re.search(skill_content))
    should_replace = has_section and ("由优化器自动创建" in skill_content)

    base_content = skill_content
    if should_replace:
        matches = list(section_heading_re.finditer(skill_content))
        if matches:
            base_content = skill_content[: matches[-1].start()].rstrip()

    excluded_prefixes = ("snapshots/", ".opt/")
    excluded_exact = {
        "AUXILIARY_META.json",
        "diagnoses.json",
        "OPTIMIZATION_REPORT.md",
        "meta.json",
    }

    def is_excluded(rel_path: str) -> bool:
        if not rel_path:
            return True
        if rel_path.startswith(excluded_prefixes):
            return True
        if rel_path in excluded_exact:
            return True
        if "/__pycache__/" in f"/{rel_path}/":
            return True
        return False

    def normalize_summary(text: str) -> str:
        text = (text or "").strip()
        text = re.sub(r"\s+", " ", text)
        if len(text) > 160:
            text = text[:157].rstrip() + "..."
        return text

    def auto_summary(rel_path: str, content: str) -> str:
        content = content or ""
        lines = content.splitlines()

        def meaningful(line: str) -> bool:
            s = (line or "").strip()
            if not s:
                return False
            low = s.lower()
            if low.startswith("#!/"):
                return False
            if low in {"set -e", "set -eu", "set -euo pipefail"}:
                return False
            if low.startswith(("import ", "from ")):
                return False
            return True

        def pick_first_meaningful() -> str:
            for ln in lines[:200]:
                s = (ln or "").strip()
                if not s:
                    continue
                if s.startswith("#") and not s.startswith("# "):
                    continue
                if meaningful(s):
                    return s.lstrip("#").strip()
            for ln in lines:
                s = (ln or "").strip()
                if meaningful(s):
                    return s.lstrip("#").strip()
            return ""

        if rel_path.endswith(".md"):
            for ln in lines[:80]:
                s = (ln or "").strip()
                if s.startswith("#"):
                    s = s.lstrip("#").strip()
                    if s:
                        return s
            return pick_first_meaningful()

        if rel_path.endswith((".sh", ".bash")):
            for ln in lines[:200]:
                s = (ln or "").strip()
                if not s:
                    continue
                if (
                    "用法:" in s
                    or "usage:" in s.lower()
                    or "作用:" in s
                    or "功能:" in s
                ):
                    return s.lstrip("#").strip()
            return pick_first_meaningful()

        if rel_path.endswith(".py"):
            m = re.search(r'(?s)^\s*(?:"""|\'\'\')\s*(.*?)\s*(?:"""|\'\'\')', content)
            if m:
                doc = (m.group(1) or "").strip().splitlines()
                for ln in doc:
                    s = (ln or "").strip()
                    if s:
                        return s
            return pick_first_meaningful()

        return pick_first_meaningful()

    def ensure_summary(rel_path: str) -> str:
        summary = (auxiliary_meta.get(rel_path) or "").strip()
        if summary:
            return normalize_summary(summary)
        generated = normalize_summary(
            auto_summary(rel_path, auxiliary_files.get(rel_path, ""))
        )
        if generated:
            auxiliary_meta[rel_path] = generated
            return generated
        generated = normalize_summary(rel_path)
        auxiliary_meta[rel_path] = generated
        return generated

    entrypoints: list[str] = []
    references: list[str] = []
    others: list[str] = []
    content_lower = skill_content.lower()

    def is_entrypoint_script(rel_path: str, summary: str) -> bool:
        if not rel_path.startswith("scripts/"):
            return False
        s = (summary or "").strip().lower()
        if not s:
            return False
        if "用法:" in s and ("作用:" in s or "功能:" in s):
            return True
        if rel_path.lower() in s:
            return True
        if re.search(r"\b(python|bash|sh|node|uv)\b", s) and "scripts/" in s:
            return True
        return False

    for rel_path in sorted(auxiliary_files.keys()):
        if is_excluded(rel_path):
            continue
        if not (rel_path.startswith("scripts/") or rel_path.startswith("references/")):
            continue
        if not should_replace:
            if rel_path.lower() in content_lower:
                continue
            base = Path(rel_path).name
            if base and base != rel_path:
                if re.search(
                    rf"(?i)(?<![A-Za-z0-9._-]){re.escape(base)}(?![A-Za-z0-9._-])",
                    skill_content,
                ):
                    continue
        summary = ensure_summary(rel_path)
        is_ref = rel_path.startswith("references/")
        is_entry = is_entrypoint_script(rel_path, summary)
        if is_ref:
            references.append(rel_path)
        elif is_entry:
            entrypoints.append(rel_path)
        else:
            others.append(rel_path)

    def line_for(rel_path: str) -> str:
        desc = ensure_summary(rel_path)
        return f"- **{rel_path}** - {desc}\n"

    def inject_progressive_references(content: str) -> str:
        if not references and not entrypoints:
            return content
        if re.search(r"(?im)^##\s+file references\s*$", content):
            return content

        def choose_reference() -> Optional[str]:
            preferred = ["references/REFERENCE.md", "references/README.md"]
            for p in preferred:
                if p in auxiliary_files:
                    return p
            return references[0] if references else None

        ref_path = choose_reference()
        parts: list[str] = []
        parts.append("## File references\n")
        added_any = False
        if ref_path and f"({ref_path})" not in content and ref_path not in content:
            parts.append(f"See [the reference guide]({ref_path}) for details.\n")
            added_any = True
        if entrypoints:
            new_entrypoints = [p for p in entrypoints if p not in content]
            if new_entrypoints:
                parts.append("\nRun the extraction script:\n")
                for p in new_entrypoints:
                    parts.append(f"\n{p}\n")
                added_any = True
        if added_any:
            parts.append(
                "\nKeep file references one level deep from SKILL.md. Avoid deeply nested reference chains.\n"
            )
        block = "\n".join(parts).strip() + "\n"
        if not added_any:
            return content

        insert_match = re.search(r"(?im)^#\s+(instruction|workflow)\b.*$", content)
        if insert_match:
            insert_at = insert_match.end()
            return (
                content[:insert_at]
                + "\n\n"
                + block
                + "\n"
                + content[insert_at:].lstrip("\n")
            )

        fm_match = re.match(r"^---\n.*?\n---\n?", content, re.DOTALL)
        if fm_match:
            insert_at = fm_match.end()
            return (
                content[:insert_at].rstrip()
                + "\n\n"
                + block
                + "\n"
                + content[insert_at:].lstrip("\n")
            )

        return block + "\n" + content.lstrip("\n")

    section = ""
    if entrypoints or references or others:
        section = "\n\n## 辅助文件\n\n"
        if entrypoints:
            section += "### 执行入口\n\n"
            for p in entrypoints:
                section += line_for(p)
            section += "\n"
        if references:
            section += "### 参考资料\n\n"
            for p in references:
                section += line_for(p)
            section += "\n"
        if others:
            section += "### 其他\n\n"
            for p in others:
                section += line_for(p)
            section += "\n"

    if has_section and not should_replace:
        injected = inject_progressive_references(skill_content)
        return injected

    injected = inject_progressive_references(base_content)
    if not section:
        return injected.rstrip() + "\n"
    return injected.rstrip() + section.rstrip() + "\n"


def extract_referenced_skill_paths(skill_content: str) -> set[str]:
    if not skill_content:
        return set()
    matches = re.findall(r"\b(?:scripts|references)/[A-Za-z0-9._/\-]+\b", skill_content)
    return set(matches)


def build_auto_snapshot_reason(mode: str, diagnoses: list) -> str:
    base = f"自动优化: {mode} mode"
    if not diagnoses:
        return f"{base}（无诊断）"

    def clean_line(text: str) -> str:
        text = (text or "").strip()
        text = re.sub(r"\s+", " ", text)
        return text

    def format_item(d) -> str:
        dim = clean_line(str(getattr(d, "dimension", "") or "")) or "Unknown"
        severity = clean_line(str(getattr(d, "severity", "") or ""))
        desc = str(getattr(d, "description", "") or "").strip() or "（无描述）"
        header = f"[{dim}]"
        if severity:
            header = f"[{dim}/{severity}]"
        return f"{header} {desc}"

    lines = [base, "问题列表:"]
    for i, d in enumerate(diagnoses, start=1):
        lines.append(f"- {i}. {format_item(d)}")
    return "\n".join(lines)


def print_completion_summary(
    success: bool,
    output_dir: Path,
    skill_name: str,
    diagnoses_count: int,
    auxiliary_files: list[str],
    mode: str,
):
    """
    输出清晰明确的完成状态摘要
    """
    print("\n" + "=" * 60)

    if success:
        print("✅ 优化完成！")
    else:
        print("⚠️ 优化部分完成")

    print("-" * 60)
    print(f"Skill 名称: {skill_name}")
    print(f"优化模式: {mode}")
    print(f"诊断数量: {diagnoses_count}")
    print(f"输出目录: {output_dir}")

    if auxiliary_files:
        print(f"\n生成的文件:")
        print(f"  - SKILL.md")
        for f in auxiliary_files:
            print(f"  - {f}")

    if diagnoses_count > 0:
        print(f"\n诊断报告:")
        print(f"  - diagnoses.json")
        print(f"  - OPTIMIZATION_REPORT.md")

    print("=" * 60)


def run_optimizer(
    mode: str,
    input_path: Path,
    output_path: Optional[Path] = None,
    human_feedback: Optional[str] = None,
    open_diff: bool = True,
) -> List[Path]:
    """
    Main entry point for function calls.

    Args:
        mode: 'static' or 'dynamic' or 'hybrid'
        input_path: Path to input directory or file
        output_path: Path to output directory (optional)
        human_feedback: Optional human feedback content to guide optimization

    Returns:
        List[Path]: List of paths to the optimized skill directories
    """

    load_dotenv(ENV_FILE)

    # 1. Initialize Components
    try:
        llm_client = RealLLMClient()
    except ValueError as e:
        logger.error(str(e))
        return []

    # Use Factory Method to create optimizer with all dependencies wired up
    optimizer = SkillOptimizer.from_llm_client(llm_client)
    report_generator = OptimizationReportGenerator(llm_client)

    # 2. Resolve Paths
    input_path = Path(input_path).resolve()
    input_dir = input_path.parent if input_path.is_file() else input_path

    if output_path:
        workspace_dir = Path(output_path).resolve()
    else:
        # If no output_path is provided:
        # Check if input_dir already looks like a workspace (has snapshots)
        if (input_dir / "snapshots").exists():
            workspace_dir = input_dir
        else:
            # Otherwise, create a new timestamped directory next to input_dir
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            workspace_dir = input_dir.parent / f"{input_dir.name}-optimized-{mode}-{timestamp}"

    # Initialize workspace if it's new
    if workspace_dir != input_dir and not workspace_dir.exists():
        import shutil

        def ignore_patterns(d, contents):
            return [
                "snapshots",
                ".git",
                "__pycache__",
                "node_modules",
                ".venv",
                "venv",
                ".opt",
            ]

        shutil.copytree(input_dir, workspace_dir, ignore=ignore_patterns)
        logger.info(f"Created new workspace: {workspace_dir}")

    # 3. Locate SKILL.md
    skill_files = []
    explicit_skill_file = input_path.is_file() and input_path.name.lower() == "skill.md"
    if explicit_skill_file:
        try:
            rel_path = input_path.relative_to(input_dir)
            skill_files.append(workspace_dir / rel_path)
        except ValueError:
            skill_files.append(workspace_dir / "SKILL.md")
    else:
        skill_files = list(workspace_dir.rglob("SKILL.md"))  # Recursive search

    if explicit_skill_file:
        skill_files = [f for f in skill_files if f.exists()]
    else:
        skill_files = [
            f
            for f in skill_files
            if f.exists() and "snapshots" not in f.parts and ".opt" not in f.parts
        ]
    skill_files.sort()

    if not skill_files:
        logger.error(f"No SKILL.md found in {workspace_dir}")
        return []

    logger.info(
        f"Found {len(skill_files)} skill(s) to process in workspace {workspace_dir}."
    )

    optimized_paths = []
    diff_open_payload = None

    # 4. Parallel Processing Function
    def process_skill_file(skill_file):
        # Create skill-specific logger with unique identifier
        skill_name = skill_file.parent.name
        skill_logger = logging.getLogger(f"skill.{skill_name}")

        # Configure skill logger with detailed format
        if not skill_logger.handlers:
            handler = logging.StreamHandler()

            # Color coding for different log levels
            class SkillLogFormatter(logging.Formatter):
                def format(self, record):
                    # Add skill name prefix
                    record.msg = f"[SKILL:{skill_name}] {record.msg}"

                    # Color coding
                    if record.levelno >= logging.ERROR:
                        # Red for errors
                        return f"\033[91m{super().format(record)}\033[0m"
                    elif record.levelno >= logging.WARNING:
                        # Yellow for warnings
                        return f"\033[93m{super().format(record)}\033[0m"
                    elif record.levelno >= logging.INFO:
                        # Green for info
                        return f"\033[92m{super().format(record)}\033[0m"
                    else:
                        # Default for debug
                        return super().format(record)

            formatter = SkillLogFormatter(
                "%(asctime)s - %(levelname)s - %(message)s", datefmt="%H:%M:%S"
            )
            handler.setFormatter(formatter)
            skill_logger.addHandler(handler)
            skill_logger.setLevel(logging.INFO)
            skill_logger.propagate = False  # Prevent duplicate logs

        skill_logger.info("=" * 60)
        skill_logger.info(f"Starting optimization for: {skill_file.name}")
        skill_logger.info(f"Skill directory: {skill_file.parent}")
        skill_logger.info(f"Optimization mode: {mode}")
        skill_logger.info("=" * 60)

        try:
            # Initialize variables
            optimized_genome = None
            diagnoses = []

            # Load Genome initially (try from directory for context)
            try:
                initial_genome = SkillGenome.from_directory(skill_file.parent)
            except Exception as e:
                skill_logger.warning(
                    f"Failed to load from directory: {e}. Fallback to file."
                )
                with open(skill_file, "r", encoding="utf-8") as f:
                    initial_genome = SkillGenome.from_markdown(f.read())

            if mode == "static":
                skill_logger.info("Mode: Static (Cold Start)")
                skill_logger.info("⏳ [进度] 正在执行静态评估...")
                skill_logger.info("⏳ [进度] 预计需要 1-3 分钟，请耐心等待...")
                skill_logger.info("⏳ [进度] LLM 调用中...")
                optimized_genome, diagnoses = optimizer.optimize_static(skill_file)

            elif mode == "feedback":
                skill_logger.info("Mode: Feedback (User Revision)")
                skill_logger.info("⏳ [进度] 正在执行反馈改写（基于你的修改意见）...")
                skill_logger.info("⏳ [进度] 预计需要 1-3 分钟，请耐心等待...")
                skill_logger.info("⏳ [进度] LLM 调用中...")
                optimized_genome, diagnoses = optimizer.optimize_feedback(
                    skill_file, human_feedback=human_feedback
                )

            elif mode == "dynamic":
                skill_logger.info("Mode: Dynamic (Experience Crystallization)")
                skill_logger.info("⏳ [进度] 正在获取历史执行记录...")
                try:
                    report_items = get_skill_logs(skill=initial_genome.name, limit=3)
                except ValueError as e:
                    skill_logger.warning(str(e))
                    skill_logger.warning(
                        "Skill Insight 配置不可用，降级为 static 模式。"
                    )
                    optimized_genome, diagnoses = optimizer.optimize_static(skill_file)
                else:
                    skill_logger.info("⏳ [进度] 正在执行动态优化...")
                    skill_logger.info("⏳ [进度] 预计需要 3-5 分钟，请耐心等待...")
                    skill_logger.info("⏳ [进度] LLM 调用中...")
                    optimized_genome, diagnoses = optimizer.optimize_dynamic(
                        genome=initial_genome, report_items=report_items or []
                    )

            elif mode == "hybrid":
                skill_logger.info("Mode: Hybrid (Static + Dynamic)")
                skill_logger.info("⏳ [进度] 正在获取历史执行记录...")
                try:
                    report_items = get_skill_logs(skill=initial_genome.name, limit=3)
                except ValueError as e:
                    skill_logger.warning(str(e))
                    skill_logger.warning(
                        "Skill Insight 配置不可用，降级为 static 模式。"
                    )
                    optimized_genome, diagnoses = optimizer.optimize_static(skill_file)
                else:
                    skill_logger.info("⏳ [进度] 正在执行混合优化（静态 + 动态）...")
                    skill_logger.info("⏳ [进度] 预计需要 5-8 分钟，请耐心等待...")
                    skill_logger.info("⏳ [进度] LLM 调用中...")
                    optimized_genome, diagnoses = optimizer.optimize_hybrid(
                        skill_path=skill_file,
                        report_items=report_items or [],
                    )

            # 5. Save Result
            from snapshot_manager import SnapshotManager

            sm = SnapshotManager(skill_file.parent)
            sm.create_v0_if_needed()
            base_for_diff = (
                sm.get_current_base_version() or sm.get_latest_base_version() or "v0"
            )

            is_feedback = mode == "feedback"
            if is_feedback:
                reason = f"用户反馈: {human_feedback[:50]}..."
                source = "user"
            else:
                reason = build_auto_snapshot_reason(mode, diagnoses)
                source = "auto"

            new_version = sm.create_snapshot(
                mode=mode, reason=reason, source=source, is_feedback=is_feedback
            )

            skill_save_dir = sm.snapshots_dir / new_version

            # Save SKILL.md
            if optimized_genome:
                new_content = optimized_genome.to_markdown()
                if not new_content or len(new_content) < 50:
                    skill_logger.warning(
                        "Optimized SKILL.md content is suspiciously short or empty!"
                    )

                referenced = extract_referenced_skill_paths(new_content)
                if referenced:
                    missing = []
                    for p in referenced:
                        if p in optimized_genome.files:
                            continue
                        if p in initial_genome.files:
                            optimized_genome.files[p] = initial_genome.files[p]
                            if (
                                p in initial_genome.file_meta
                                and p not in optimized_genome.file_meta
                            ):
                                optimized_genome.file_meta[p] = (
                                    initial_genome.file_meta[p]
                                )
                            continue
                        missing.append(p)
                    if missing:
                        skill_logger.warning(
                            f"Optimized SKILL.md references missing files. Falling back to original. Missing: {missing}"
                        )
                        optimized_genome = initial_genome
                        new_content = optimized_genome.to_markdown()

                new_content = integrate_auxiliary_references(
                    new_content, optimized_genome.files, optimized_genome.file_meta
                )

                save_file = skill_save_dir / "SKILL.md"
                with open(save_file, "w", encoding="utf-8") as f:
                    f.write(new_content)
                skill_logger.info(f"Optimized skill saved to: {save_file}")

                is_valid, error_msg = validate_skill_file(save_file)
                if not is_valid:
                    skill_logger.warning(f"SKILL.md 验证失败: {error_msg}")
                else:
                    skill_logger.info(f"SKILL.md 验证通过: {save_file}")

                # Save Auxiliary Files (scripts, references, etc.)
                # optimized_genome.files contains relative paths -> content
                if not optimized_genome.files:
                    skill_logger.warning(
                        "No auxiliary files found in optimized genome! (Scripts/References may be missing)"
                    )

                for rel_path, file_content in optimized_genome.files.items():
                    if rel_path.startswith(("snapshots/", ".opt/")):
                        continue
                    if rel_path in {
                        "AUXILIARY_META.json",
                        "diagnoses.json",
                        "OPTIMIZATION_REPORT.md",
                        "meta.json",
                    }:
                        continue
                    dest_path = skill_save_dir / rel_path
                    dest_path.parent.mkdir(parents=True, exist_ok=True)
                    if rel_path.startswith("references/"):
                        file_content = sanitize_reference_content(file_content)
                    with open(dest_path, "w", encoding="utf-8") as f:
                        f.write(file_content)
                    skill_logger.info(f"Saved auxiliary file: {rel_path}")

                    is_valid, error_msg = validate_auxiliary_file(dest_path)
                    if not is_valid:
                        skill_logger.warning(f"辅助文件验证失败: {error_msg}")
                    else:
                        skill_logger.info(f"辅助文件验证通过: {rel_path}")

                try:
                    import json

                    meta_out: dict[str, str] = {}
                    for rel_path in sorted(optimized_genome.files.keys()):
                        if rel_path.startswith(("snapshots/", ".opt/")):
                            continue
                        if rel_path in {
                            "AUXILIARY_META.json",
                            "diagnoses.json",
                            "OPTIMIZATION_REPORT.md",
                            "meta.json",
                        }:
                            continue
                        if not (
                            rel_path.startswith("scripts/")
                            or rel_path.startswith("references/")
                        ):
                            continue
                        meta_out[rel_path] = (
                            optimized_genome.file_meta.get(rel_path) or ""
                        ).strip()

                    snapshot_meta_path = skill_save_dir / "AUXILIARY_META.json"
                    with open(snapshot_meta_path, "w", encoding="utf-8") as f:
                        json.dump(meta_out, f, indent=2, ensure_ascii=False)
                    skill_logger.info(f"Saved auxiliary meta: {snapshot_meta_path}")

                    skill_opt_dir = skill_file.parent / ".opt"
                    skill_opt_dir.mkdir(parents=True, exist_ok=True)
                    cache_meta_path = skill_opt_dir / "auxiliary_meta.json"
                    with open(cache_meta_path, "w", encoding="utf-8") as f:
                        json.dump(meta_out, f, indent=2, ensure_ascii=False)
                    skill_logger.info(f"Saved auxiliary meta cache: {cache_meta_path}")
                except Exception as e:
                    skill_logger.warning(f"Failed to save auxiliary meta: {e}")
            else:
                skill_logger.warning("Optimization returned None. Skipping save.")

            # Save Diagnoses
            if diagnoses:
                import json

                diagnoses_file = skill_save_dir / "diagnoses.json"
                diagnoses_data = [
                    {
                        "dimension": d.dimension,
                        "issue_type": d.issue_type,
                        "severity": d.severity,
                        "description": d.description,
                        "suggested_fix": d.suggested_fix,
                    }
                    for d in diagnoses
                ]
                with open(diagnoses_file, "w", encoding="utf-8") as f:
                    json.dump(diagnoses_data, f, indent=2, ensure_ascii=False)
                skill_logger.info(f"Saved diagnoses to: {diagnoses_file}")
                skill_logger.info(f"Total diagnoses: {len(diagnoses)}")

            # Generate and Save Optimization Report
            if optimized_genome and diagnoses:
                report_content = report_generator.generate_report(
                    original=initial_genome,
                    optimized=optimized_genome,
                    diagnoses=diagnoses,
                )
                report_file = skill_save_dir / "OPTIMIZATION_REPORT.md"
                with open(report_file, "w", encoding="utf-8") as f:
                    f.write(report_content)
                skill_logger.info(f"Saved optimization report to: {report_file}")

            # Also update the actual skill directory to match the latest snapshot
            sm.revert_to(new_version)

            diff_payload = {
                "snapshots_dir": sm.snapshots_dir,
                "title": initial_genome.name,
                "default_base": base_for_diff,
                "default_current": new_version,
                "skill_dir": skill_file.parent,
            }

            # Record successful optimization path
            skill_save_dir = sm.snapshots_dir / new_version

            skill_logger.info("=" * 60)
            skill_logger.info(f"✅ OPTIMIZATION COMPLETED SUCCESSFULLY")
            skill_logger.info(f"Skill: {initial_genome.name}")
            skill_logger.info(f"New version: {new_version}")
            skill_logger.info(f"Diagnoses found: {len(diagnoses)}")
            skill_logger.info(
                f"Files saved: {len(optimized_genome.files) if optimized_genome else 0}"
            )
            skill_logger.info(f"Output directory: {skill_save_dir}")
            skill_logger.info("=" * 60)

            return {
                "success": True,
                "skill_save_dir": skill_save_dir,
                "diff_payload": diff_payload,
                "skill_file": skill_file,
                "new_version": new_version,
            }

        except Exception as e:
            skill_logger.error("=" * 60)
            skill_logger.error(f"❌ OPTIMIZATION FAILED")
            skill_logger.error(f"Skill: {skill_file}")
            skill_logger.error(f"Error: {e}")
            skill_logger.error("=" * 60)
            import traceback

            traceback.print_exc()
            return {"success": False, "skill_file": skill_file, "error": str(e)}

    # 5. Execute Parallel Processing
    import concurrent.futures
    from concurrent.futures import ThreadPoolExecutor

    logger.info(f"Starting parallel processing of {len(skill_files)} skill(s)...")

    # Use ThreadPoolExecutor for I/O bound operations (LLM calls, file I/O)
    max_workers = min(
        10, len(skill_files)
    )  # Limit concurrent workers to avoid overwhelming resources
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Submit all tasks
        future_to_skill = {
            executor.submit(process_skill_file, skill_file): skill_file
            for skill_file in skill_files
        }

        # Collect results as they complete
        for future in concurrent.futures.as_completed(future_to_skill):
            skill_file = future_to_skill[future]
            try:
                result = future.result()
                if result["success"]:
                    optimized_paths.append(result["skill_save_dir"])
                    # Keep the last diff payload for final diff generation
                    diff_open_payload = result["diff_payload"]
                else:
                    # Use main logger for overall process errors
                    logger.error(
                        f"❌ Overall process failed for {skill_file}: {result.get('error', 'Unknown error')}"
                    )
            except Exception as e:
                logger.error(f"❌ Unexpected error processing {skill_file}: {e}")
                import traceback

                traceback.print_exc()

    if diff_open_payload:
        try:
            import subprocess
            import webbrowser

            diff_script = Path(__file__).parent / "diff_viewer.py"
            diff_out = diff_open_payload["skill_dir"] / ".opt" / "diff.html"
            subprocess.run(
                [
                    sys.executable,
                    str(diff_script),
                    "--snapshots",
                    str(diff_open_payload["snapshots_dir"]),
                    "--title",
                    diff_open_payload["title"],
                    "--default-base",
                    diff_open_payload["default_base"],
                    "--default-current",
                    diff_open_payload["default_current"],
                    "--no-open",
                    "--output",
                    str(diff_out),
                ],
                check=False,
            )
            logger.info(f"Diff HTML written to: {diff_out}")
            if open_diff and len(skill_files) == 1:
                webbrowser.open(diff_out.resolve().as_uri())
        except Exception as e:
            logger.error(f"Failed to generate/open diff viewer: {e}")

    return optimized_paths


# --- CLI Entry Point ---


def main():
    parser = argparse.ArgumentParser(description="Skill Optimizer CLI")

    parser.add_argument(
        "--action",
        choices=["optimize", "accept", "revert"],
        default="optimize",
        help="Action to perform. Default is 'optimize'.",
    )
    parser.add_argument(
        "--mode",
        choices=["static", "dynamic", "feedback", "hybrid"],
        help="Optimization mode: static (cold) or dynamic (trace-based) or feedback (human revision) or hybrid (static+dynamic). Required for 'optimize' action.",
    )
    parser.add_argument(
        "--input",
        "-i",
        type=str,
        required=True,
        help="Input path (directory containing SKILL.md or file path)",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=str,
        help="Output directory (optional, defaults to input dir)",
    )
    parser.add_argument(
        "--no-open-diff",
        action="store_true",
        help="Generate diff HTML but do not open it in the browser.",
    )
    parser.add_argument(
        "--feedback",
        "-f",
        type=str,
        help="Path to feedback file or inline feedback text. Only allowed with --mode feedback.",
    )
    parser.add_argument(
        "--target-version",
        type=str,
        help="Target version to revert to (e.g. 'v1'). Required for 'revert' action.",
    )

    args = parser.parse_args()

    input_path = Path(args.input)

    if args.action == "accept":
        from snapshot_manager import SnapshotManager

        skill_dir = input_path.parent if input_path.is_file() else input_path
        if not (skill_dir / "snapshots").exists():
            logger.error(
                f"❌ 目录 {skill_dir} 中没有 snapshots。请确保你在已优化的工作区中执行 accept。"
            )
            return
        sm = SnapshotManager(skill_dir)
        new_ver = sm.accept_latest()
        if new_ver:
            sm.revert_to(new_ver)
            logger.info(f"✅ 成功接受优化，已保存为新基线版本: {new_ver}")
        else:
            logger.error("❌ 没有可接受的版本。")
        return

    if args.action == "revert":
        if not args.target_version:
            parser.error("--target-version is required for 'revert' action")
        from snapshot_manager import SnapshotManager

        skill_dir = input_path.parent if input_path.is_file() else input_path
        if not (skill_dir / "snapshots").exists():
            logger.error(
                f"❌ 目录 {skill_dir} 中没有 snapshots。请确保你在已优化的工作区中执行 revert。"
            )
            return
        sm = SnapshotManager(skill_dir)
        if sm.revert_to(args.target_version):
            logger.info(f"✅ 成功回滚到版本: {args.target_version}")
        else:
            logger.error(f"❌ 找不到指定的版本: {args.target_version}")
        return

    if not args.mode:
        parser.error("--mode is required for 'optimize' action")

    output_path = Path(args.output) if args.output else None

    try:
        human_feedback_content = resolve_human_feedback_content(
            args.mode, args.feedback
        )
    except CliArgsError as e:
        parser.error(str(e))
    except OSError as e:
        parser.error(f"Failed to read feedback file: {e}")

    optimized_paths = run_optimizer(
        args.mode,
        input_path,
        output_path,
        human_feedback=human_feedback_content,
        open_diff=not args.no_open_diff,
    )

    if optimized_paths:
        logger.info(
            f"Optimization completed. Modified skill paths: {[str(p) for p in optimized_paths]}"
        )


if __name__ == "__main__":
    main()