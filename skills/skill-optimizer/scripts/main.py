import argparse
import datetime
import logging
import os
import re
import sys
import datetime
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

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


# --- LLM Client Setup ---
class RealLLMClient:
    def __init__(self):
        # Override: if LLM_* env vars are set, use them directly
        llm_key = os.getenv("LLM_API_KEY")
        if llm_key:
            api_key = llm_key
            base_url = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/")
            model_name = os.getenv("LLM_MODEL", "deepseek-chat")
        elif os.getenv("DEEPSEEK_API_KEY"):
            api_key = os.getenv("DEEPSEEK_API_KEY")
            base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/")
            model_name = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
        elif os.getenv("OPENAI_API_KEY"):
            api_key = os.getenv("OPENAI_API_KEY")
            base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
            model_name = os.getenv("OPENAI_MODEL", "gpt-4")
        elif os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"):
            api_key = os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")
            base_url = os.getenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
            model_name = os.getenv("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022")
        else:
            from constants import ENV_FILE

            raise ValueError(
                f"\n❌ Error: No API key found in environment.\n"
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
        logger.info(f"[RealLLM] Using base_url={base_url}, model={model_name}")

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
    
    content = file_path.read_text(encoding='utf-8')
    if not content or len(content) < 100:
        return False, f"文件内容过短: {len(content)} 字符"
    
    if not content.startswith('---'):
        return False, "缺少 YAML frontmatter"
    
    frontmatter_match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not frontmatter_match:
        return False, "frontmatter 格式错误"
    
    frontmatter = frontmatter_match.group(1)
    if 'name:' not in frontmatter:
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
    
    content = file_path.read_text(encoding='utf-8')
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
                if "用法:" in s or "usage:" in s.lower() or "作用:" in s or "功能:" in s:
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
        generated = normalize_summary(auto_summary(rel_path, auxiliary_files.get(rel_path, "")))
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
            return content[:insert_at] + "\n\n" + block + "\n" + content[insert_at:].lstrip("\n")

        fm_match = re.match(r"^---\n.*?\n---\n?", content, re.DOTALL)
        if fm_match:
            insert_at = fm_match.end()
            return content[:insert_at].rstrip() + "\n\n" + block + "\n" + content[insert_at:].lstrip("\n")

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
    matches = re.findall(r"\b(?:scripts|references)/[A-Za-z0-9._/\-]+\.[A-Za-z0-9]+\b", skill_content)
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
    mode: str
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


def _resolve_skill_dir_in_workspace(workspace_dir: Path, skill_name: str) -> Path:
    """Resolve the inner skill directory path within a workspace.

    The workspace has a two-layer structure:
      workspace_dir/           <- outer: snapshots, reports, etc.
        skill-name/            <- inner: pure skill content (SKILL.md + auxiliary files)

    When iterating on an existing workspace (input has snapshots),
    the skill content lives in the workspace root for backward compatibility.
    """
    inner_dir = workspace_dir / skill_name
    if inner_dir.exists() and (inner_dir / "SKILL.md").exists():
        return inner_dir
    if (workspace_dir / "SKILL.md").exists():
        return workspace_dir
    return inner_dir


def _sync_skill_to_inner_dir(skill_dir: Path, inner_dir: Path, skill_name: str):
    """Sync pure skill files from skill_dir to inner_dir within the workspace.

    Only copies SKILL.md and auxiliary files (scripts/, references/),
    excluding snapshots, reports, diagnoses, and other process artifacts.
    """
    import shutil

    inner_dir.mkdir(parents=True, exist_ok=True)

    exclude_names = {
        "snapshots", ".git", "__pycache__", "node_modules",
        ".venv", "venv", ".opt", "diagnoses.json",
        "OPTIMIZATION_REPORT.md", "AUXILIARY_META.json",
    }

    for item in skill_dir.iterdir():
        if item.name in exclude_names:
            continue
        if item.name.startswith("."):
            continue
        dest = inner_dir / item.name
        if item.is_dir():
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)

    logger.info(f"Synced pure skill content to inner dir: {inner_dir}")


def _archive_old_skill(skill_name: str, opencode_skills_dir: Path) -> Optional[Path]:
    """Archive an old skill from .opencode/skills/ to ~/.agent-insight/skill-history/.

    Handles name collisions by appending timestamp and optional index suffix.

    Returns:
        Path to the archive directory if archived, None if nothing to archive.
    """
    import shutil
    from pathlib import Path

    old_skill_dir = opencode_skills_dir / skill_name
    if not old_skill_dir.exists():
        return None

    history_base = GLOBAL_CONFIG_DIR / "skill-history"
    history_base.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    archive_dir = history_base / f"{skill_name}-{timestamp}"

    if archive_dir.exists():
        idx = 1
        while (history_base / f"{skill_name}-{timestamp}-{idx}").exists():
            idx += 1
        archive_dir = history_base / f"{skill_name}-{timestamp}-{idx}"

    shutil.move(str(old_skill_dir), str(archive_dir))
    logger.info(f"Archived old skill to: {archive_dir}")
    return archive_dir


def run_optimizer(
    mode: str,
    input_path: Path,
    project_dir: Path,
    human_feedback: Optional[str] = None,
    trajectories: Optional[Path] = None,
    open_diff: bool = True,
) -> List[Path]:
    """
    Main entry point for function calls.

    Args:
        mode: 'static' or 'dynamic' or 'feedback' or 'traces'
        input_path: Path to input directory or file
        project_dir: Project root directory for creating the optimized workspace
        human_feedback: Optional human feedback content to guide optimization
        open_diff: Whether to open diff in browser

    Returns:
        List[Path]: List of paths to the optimized skill directories (inner skill dirs)
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

    # Determine the skill name from the input directory
    # For iteration on existing workspaces, try to find the inner skill dir first
    skill_name = input_dir.name
    if (input_dir / "snapshots").exists():
        # This is an existing workspace - look for inner skill dir
        for sub in input_dir.iterdir():
            if sub.is_dir() and (sub / "SKILL.md").exists() and sub.name != "snapshots":
                skill_name = sub.name
                break

    # Check if input_dir already looks like a workspace (has snapshots)
    if (input_dir / "snapshots").exists():
        workspace_dir = input_dir
    else:
        base_dir = Path(project_dir).resolve()
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        workspace_dir = base_dir / f"{input_dir.name}-optimized-{timestamp}"

    # Determine if this is a new workspace (first-time optimization) or iteration
    is_new_workspace = workspace_dir != input_dir and not workspace_dir.exists()

    # Initialize workspace if it's new
    # Two-layer structure: workspace_dir/ (outer) -> skill_name/ (inner, pure skill)
    if is_new_workspace:
        import shutil
        inner_skill_dir = workspace_dir / skill_name

        def ignore_patterns(d, contents):
            return ['snapshots', '.git', '__pycache__', 'node_modules', '.venv', 'venv', '.opt']
        shutil.copytree(input_dir, inner_skill_dir, ignore=ignore_patterns)
        logger.info(f"Created new workspace: {workspace_dir}")
        logger.info(f"Inner skill directory: {inner_skill_dir}")
    else:
        inner_skill_dir = _resolve_skill_dir_in_workspace(workspace_dir, skill_name)
        # Ensure inner skill dir exists for iteration on existing workspaces
        if not inner_skill_dir.exists() or not (inner_skill_dir / "SKILL.md").exists():
            # Backward compat: if workspace root has SKILL.md, create inner dir
            if (workspace_dir / "SKILL.md").exists():
                _sync_skill_to_inner_dir(workspace_dir, inner_skill_dir, skill_name)

    # 3. Locate SKILL.md - search in the inner skill directory
    skill_files = []
    explicit_skill_file = input_path.is_file() and input_path.name.lower() == "skill.md"
    if explicit_skill_file:
        skill_files.append(inner_skill_dir / "SKILL.md")
    else:
        skill_files = list(inner_skill_dir.rglob("SKILL.md"))

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
        logger.error(f"No SKILL.md found in {inner_skill_dir}")
        return []

    logger.info(f"Found {len(skill_files)} skill(s) to process in workspace {workspace_dir}.")

    optimized_paths = []
    diff_open_payload = None

    # 4. Processing Loop
    for skill_file in skill_files:
        logger.info(f"Processing: {skill_file}")
        logger.info(f"Mode: {mode}")

        try:
            # Initialize variables
            optimized_genome = None
            diagnoses = []

            # Load Genome initially (try from directory for context)
            try:
                initial_genome = SkillGenome.from_directory(skill_file.parent)
            except Exception as e:
                logger.warning(f"Failed to load from directory: {e}. Fallback to file.")
                with open(skill_file, "r", encoding="utf-8") as f:
                    initial_genome = SkillGenome.from_markdown(f.read())

            if mode == "static":
                logger.info("Mode: Static (Cold Start)")
                logger.info("⏳ [进度] 正在执行静态评估...")
                logger.info("⏳ [进度] 预计需要 1-3 分钟，请耐心等待...")
                logger.info("⏳ [进度] LLM 调用中...")
                optimized_genome, diagnoses = optimizer.optimize_static(
                    skill_file
                )

            elif mode == "feedback":
                logger.info("Mode: Feedback (User Revision)")
                logger.info("⏳ [进度] 正在执行反馈改写（基于你的修改意见）...")
                logger.info("⏳ [进度] 预计需要 1-3 分钟，请耐心等待...")
                logger.info("⏳ [进度] LLM 调用中...")
                optimized_genome, diagnoses = optimizer.optimize_feedback(
                    skill_file, human_feedback=human_feedback
                )

            elif mode == "dynamic":
                logger.info("Mode: Dynamic (Experience Crystallization)")
                logger.info("⏳ [进度] 正在获取历史执行记录...")
                try:
                    report_items = get_skill_logs(skill=initial_genome.name, limit=3)
                except ValueError as e:
                    logger.warning(str(e))
                    print("\n" + "=" * 60)
                    print("⚠️ Agent Insight 平台配置不可用，无法获取执行日志。")
                    print("动态优化需要执行日志中的优化建议，请先配置 Agent Insight 平台。")
                    print("配置方式：在 ~/.agent-insight/.env 中设置 AGENT_INSIGHT_HOST 和 AGENT_INSIGHT_API_KEY")
                    print("=" * 60)
                    continue

                if not report_items:
                    print("\n" + "=" * 60)
                    print("⚠️ 未获取到执行日志，无法进行动态优化。")
                    print(f"Skill: {initial_genome.name}")
                    print("可能原因：该 Skill 尚未在 Insight 平台上运行过，没有历史执行记录。")
                    print("建议：先运行该 Skill 产生执行日志，或改用 static 模式进行优化。")
                    print("=" * 60)
                    continue

                suggestion_count = 0
                for item in report_items:
                    issues = item.get("skill_issues")
                    if isinstance(issues, list):
                        for issue in issues:
                            if isinstance(issue, dict) and issue.get("improvement_suggestion"):
                                suggestion_count += 1

                if suggestion_count == 0:
                    print("\n" + "=" * 60)
                    print("⚠️ 执行日志中未包含优化建议（improvement_suggestion），无法进行动态优化。")
                    print(f"Skill: {initial_genome.name}")
                    print(f"获取到 {len(report_items)} 条执行日志，但其中没有包含 improvement_suggestion 优化建议。")
                    print("建议：改用 static 模式进行优化。")
                    print("=" * 60)
                    continue

                logger.info(f"📊 获取到 {len(report_items)} 条执行日志，共 {suggestion_count} 条优化建议。")
                logger.info("⏳ [进度] 正在执行动态优化...")
                logger.info("⏳ [进度] 预计需要 3-5 分钟，请耐心等待...")
                logger.info("⏳ [进度] LLM 调用中...")
                optimized_genome, diagnoses = optimizer.optimize_dynamic(
                    genome=initial_genome, report_items=report_items
                )

            elif mode == "hybrid":
                logger.info("Mode: Hybrid (Static + Dynamic)")
                logger.info("⏳ [进度] 正在获取历史执行记录...")
                try:
                    report_items = get_skill_logs(skill=initial_genome.name, limit=3)
                except ValueError as e:
                    logger.warning(str(e))
                    logger.warning("Agent Insight 配置不可用，降级为 static 模式。")
                    print("\n" + "=" * 60)
                    print("⚠️ Agent Insight 平台配置不可用，降级为静态优化模式。")
                    print("=" * 60)
                    optimized_genome, diagnoses = optimizer.optimize_static(skill_file)
                else:
                    if not report_items:
                        logger.warning("未获取到执行日志，降级为静态优化模式。")
                        print("\n" + "=" * 60)
                        print("⚠️ 未获取到执行日志，降级为静态优化模式。")
                        print(f"Skill: {initial_genome.name}")
                        print("建议：先运行该 Skill 产生执行日志后再尝试混合优化。")
                        print("=" * 60)
                        optimized_genome, diagnoses = optimizer.optimize_static(skill_file)
                    else:
                        suggestion_count = 0
                        for item in report_items:
                            issues = item.get("skill_issues")
                            if isinstance(issues, list):
                                for issue in issues:
                                    if isinstance(issue, dict) and issue.get("improvement_suggestion"):
                                        suggestion_count += 1

                        if suggestion_count == 0:
                            logger.warning("执行日志中未包含优化建议，降级为静态优化模式。")
                            print("\n" + "=" * 60)
                            print("⚠️ 执行日志中未包含优化建议（improvement_suggestion），降级为静态优化模式。")
                            print(f"Skill: {initial_genome.name}")
                            print(f"获取到 {len(report_items)} 条执行日志，但其中没有包含 improvement_suggestion 优化建议。")
                            print("=" * 60)
                            optimized_genome, diagnoses = optimizer.optimize_static(skill_file)
                        else:
                            logger.info(f"📊 获取到 {len(report_items)} 条执行日志，共 {suggestion_count} 条优化建议。")
                            logger.info("⏳ [进度] 正在执行混合优化（静态 + 动态）...")
                            logger.info("⏳ [进度] 预计需要 5-8 分钟，请耐心等待...")
                            logger.info("⏳ [进度] LLM 调用中...")
                            optimized_genome, diagnoses = optimizer.optimize_hybrid(
                                skill_path=skill_file,
                                report_items=report_items,
                            )

            elif mode == "trace":
                logger.info("Mode: Trace (Trajectory-Driven Optimization)")
                if not trajectories:
                    print("\n" + "=" * 60)
                    print("⚠️ 轨迹目录未提供，无法进行轨迹优化。")
                    print("请使用 --trajectories 参数指定轨迹目录。")
                    print("=" * 60)
                    continue

                trajectory_path = Path(trajectories)
                if not trajectory_path.exists():
                    print("\n" + "=" * 60)
                    print(f"⚠️ 轨迹目录不存在: {trajectory_path}")
                    print("=" * 60)
                    continue

                logger.info(f"📂 轨迹目录: {trajectory_path}")
                logger.info("⏳ [进度] 正在执行轨迹分析...")
                logger.info("⏳ [进度] 预计需要 5-10 分钟，请耐心等待...")
                logger.info("⏳ [进度] LLM 调用中...")
                optimized_genome, diagnoses = optimizer.optimize_trace(
                    skill_path=skill_file,
                    trajectories=trajectory_path,
                    project_path=workspace_dir,
                )

            # 5. Save Result
            from snapshot_manager import SnapshotManager
            workspace_snapshots_dir = workspace_dir / "snapshots"
            sm = SnapshotManager(inner_skill_dir, snapshots_dir=workspace_snapshots_dir)
            sm.create_v0_if_needed()
            base_for_diff = (
                sm.get_current_base_version()
                or sm.get_latest_base_version()
                or "v0"
            )
            
            is_feedback = mode == "feedback"
            if is_feedback:
                reason = f"用户反馈: {human_feedback[:50]}..."
                source = "user"
            else:
                reason = build_auto_snapshot_reason(mode, diagnoses)
                source = "auto"
                
            new_version = sm.create_snapshot(
                mode=mode,
                reason=reason,
                source=source,
                is_feedback=is_feedback
            )
            
            skill_save_dir = sm.snapshots_dir / new_version

            # Save SKILL.md
            if optimized_genome:
                new_content = optimized_genome.to_markdown()
                if not new_content or len(new_content) < 50:
                    logger.warning(
                        "Optimized SKILL.md content is suspiciously short or empty!"
                    )

                referenced = extract_referenced_skill_paths(new_content)
                if referenced:
                    initial_referenced = initial_genome.referenced_files
                    missing = []
                    for p in referenced:
                        if p in optimized_genome.files:
                            continue
                        if p in initial_genome.files:
                            optimized_genome.files[p] = initial_genome.files[p]
                            if p in initial_genome.file_meta and p not in optimized_genome.file_meta:
                                optimized_genome.file_meta[p] = initial_genome.file_meta[p]
                            continue
                        if p in initial_referenced:
                            logger.info(f"Referenced file {p} was missing in original SKILL.md, skipping validation")
                            continue
                        missing.append(p)
                    if missing:
                        logger.warning(f"Optimized SKILL.md references missing files. Falling back to original. Missing: {missing}")
                        optimized_genome = initial_genome
                        new_content = optimized_genome.to_markdown()
                
                new_content = integrate_auxiliary_references(
                    new_content, optimized_genome.files, optimized_genome.file_meta
                )

                save_file = skill_save_dir / "SKILL.md"
                with open(save_file, "w", encoding="utf-8") as f:
                    f.write(new_content)
                logger.info(f"Optimized skill saved to: {save_file}")
                
                is_valid, error_msg = validate_skill_file(save_file)
                if not is_valid:
                    logger.warning(f"SKILL.md 验证失败: {error_msg}")
                else:
                    logger.info(f"SKILL.md 验证通过: {save_file}")

                # Save Auxiliary Files (scripts, references, etc.)
                # optimized_genome.files contains relative paths -> content
                if not optimized_genome.files:
                    logger.warning(
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
                    logger.info(f"Saved auxiliary file: {rel_path}")
                    
                    is_valid, error_msg = validate_auxiliary_file(dest_path)
                    if not is_valid:
                        logger.warning(f"辅助文件验证失败: {error_msg}")
                    else:
                        logger.info(f"辅助文件验证通过: {rel_path}")

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
                        meta_out[rel_path] = (optimized_genome.file_meta.get(rel_path) or "").strip()

                    snapshot_meta_path = skill_save_dir / "AUXILIARY_META.json"
                    with open(snapshot_meta_path, "w", encoding="utf-8") as f:
                        json.dump(meta_out, f, indent=2, ensure_ascii=False)
                    logger.info(f"Saved auxiliary meta: {snapshot_meta_path}")

                    skill_opt_dir = skill_file.parent / ".opt"
                    skill_opt_dir.mkdir(parents=True, exist_ok=True)
                    cache_meta_path = skill_opt_dir / "auxiliary_meta.json"
                    with open(cache_meta_path, "w", encoding="utf-8") as f:
                        json.dump(meta_out, f, indent=2, ensure_ascii=False)
                    logger.info(f"Saved auxiliary meta cache: {cache_meta_path}")
                except Exception as e:
                    logger.warning(f"Failed to save auxiliary meta: {e}")
            else:
                logger.warning("Optimization returned None. Skipping save.")

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
                logger.info(f"Saved diagnoses to: {diagnoses_file}")
                logger.info(f"Total diagnoses: {len(diagnoses)}")

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
                logger.info(f"Saved optimization report to: {report_file}")

            # Also update the actual skill directory to match the latest snapshot
            sm.revert_to(new_version)

            # Copy optimization report to workspace root for easy access
            if optimized_genome and diagnoses:
                snapshot_report = skill_save_dir / "OPTIMIZATION_REPORT.md"
                if snapshot_report.exists():
                    import shutil
                    workspace_report = workspace_dir / "OPTIMIZATION_REPORT.md"
                    shutil.copy2(snapshot_report, workspace_report)
                    logger.info(f"Copied optimization report to workspace root: {workspace_report}")

            diff_open_payload = {
                "snapshots_dir": sm.snapshots_dir,
                "title": initial_genome.name,
                "default_base": base_for_diff,
                "default_current": new_version,
                "skill_dir": inner_skill_dir,
            }

            # Record successful optimization path (inner skill dir for loading/uploading)
            optimized_paths.append(inner_skill_dir)
            logger.info(f"Optimization completed for: {skill_file}. New version: {new_version}")
            logger.info(f"Inner skill directory (for loading): {inner_skill_dir}")
            logger.info(f"Workspace directory (for iteration): {workspace_dir}")
            
            print("\n" + "=" * 60)
            print(f"✅ 优化完成！已生成新版本: {new_version}")
            print(f"📁 工作区目录（含快照与报告）: {workspace_dir}")
            print(f"📁 Skill 目录（可加载到 .opencode/skills）: {inner_skill_dir}")
            print("👉 Diff 页面将在本次运行结束后生成（必要时自动打开）。")
            print("👉 下一步选择：满意就继续下一步 / 不满意先改 / 到此为止")
            print("=" * 60 + "\n")

        except Exception as e:
            logger.error(f"Optimization failed for {skill_file}: {e}")
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
        choices=["static", "dynamic", "feedback", "trace"],
        help="Optimization mode: static (cold), dynamic (trace-based), feedback (human revision), or trace (Trace2Skill). Required for 'optimize' action.",
    )
    parser.add_argument(
        "--trajectories",
        "-t",
        type=str,
        help="Path to trajectories directory. Required for --mode trace.",
    )
    parser.add_argument(
        "--input",
        "-i",
        type=str,
        required=True,
        help="Input path (directory containing SKILL.md or file path)",
    )
    parser.add_argument(
        "--project-dir",
        "-p",
        type=str,
        required=True,
        help="Project root directory where the optimized workspace will be created.",
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
        snapshots_dir = skill_dir / "snapshots"
        inner_skill_dir = None
        if snapshots_dir.exists():
            # Two-layer workspace: snapshots in workspace root, find inner skill dir
            for sub in skill_dir.iterdir():
                if sub.is_dir() and sub.name != "snapshots" and (sub / "SKILL.md").exists():
                    inner_skill_dir = sub
                    break
            if inner_skill_dir is None:
                # Single-layer workspace (backward compat): skill_dir has SKILL.md directly
                if (skill_dir / "SKILL.md").exists():
                    inner_skill_dir = skill_dir
        else:
            # Single-layer workspace: snapshots inside skill dir
            for sub in skill_dir.iterdir():
                if sub.is_dir() and (sub / "SKILL.md").exists() and (sub / "snapshots").exists():
                    inner_skill_dir = sub
                    snapshots_dir = sub / "snapshots"
                    break
            if inner_skill_dir is None:
                if (skill_dir / "SKILL.md").exists():
                    inner_skill_dir = skill_dir
        if not snapshots_dir.exists():
            logger.error(f"❌ 目录 {skill_dir} 中没有 snapshots。请确保你在已优化的工作区中执行 accept。")
            return
        sm = SnapshotManager(inner_skill_dir, snapshots_dir=snapshots_dir if snapshots_dir != inner_skill_dir / "snapshots" else None)
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
        snapshots_dir = skill_dir / "snapshots"
        inner_skill_dir = None
        if snapshots_dir.exists():
            for sub in skill_dir.iterdir():
                if sub.is_dir() and sub.name != "snapshots" and (sub / "SKILL.md").exists():
                    inner_skill_dir = sub
                    break
            if inner_skill_dir is None:
                if (skill_dir / "SKILL.md").exists():
                    inner_skill_dir = skill_dir
        else:
            for sub in skill_dir.iterdir():
                if sub.is_dir() and (sub / "SKILL.md").exists() and (sub / "snapshots").exists():
                    inner_skill_dir = sub
                    snapshots_dir = sub / "snapshots"
                    break
            if inner_skill_dir is None:
                if (skill_dir / "SKILL.md").exists():
                    inner_skill_dir = skill_dir
        if not snapshots_dir.exists():
            logger.error(f"❌ 目录 {skill_dir} 中没有 snapshots。请确保你在已优化的工作区中执行 revert。")
            return
        sm = SnapshotManager(inner_skill_dir, snapshots_dir=snapshots_dir if snapshots_dir != inner_skill_dir / "snapshots" else None)
        if sm.revert_to(args.target_version):
            logger.info(f"✅ 成功回滚到版本: {args.target_version}")
        else:
            logger.error(f"❌ 找不到指定的版本: {args.target_version}")
        return

    if not args.mode:
        parser.error("--mode is required for 'optimize' action")
        
    trajectories_path = Path(args.trajectories) if args.trajectories else None

    try:
        human_feedback_content = resolve_human_feedback_content(args.mode, args.feedback)
    except CliArgsError as e:
        parser.error(str(e))
    except OSError as e:
        parser.error(f"Failed to read feedback file: {e}")

    optimized_paths = run_optimizer(
        args.mode,
        input_path,
        project_dir=Path(args.project_dir),
        human_feedback=human_feedback_content,
        trajectories=trajectories_path,
        open_diff=not args.no_open_diff,
    )

    if optimized_paths:
        logger.info(
            f"Optimization completed. Modified skill paths: {[str(p) for p in optimized_paths]}"
        )


if __name__ == "__main__":
    main()
