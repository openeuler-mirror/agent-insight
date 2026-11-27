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

import logging
import os
from typing import List, Optional

from architecture.genome import SkillGenome
from architecture.scoring import Diagnosis
from langchain.agents import create_agent
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from prompts.mutation_prompts import (
    GENERAL_FIX_PROMPT,
    HUMAN_FEEDBACK_TEMPLATE,
    MUTATOR_SYSTEM_PROMPT,
)

logger = logging.getLogger(__name__)


class DiagnosticMutator:
    """
    The Causal Mutation Engine.
    Translates Diagnoses into specific Code Modifications.
    """

    def __init__(self, model_client=None):
        self.model_client = (
            model_client  # Should be a callable that takes prompt -> response
        )

    def mutate(
        self,
        parent: SkillGenome,
        diagnoses: List[Diagnosis],
        trace_id: Optional[str] = None,
        reflection: Optional[str] = None,  # New parameter for human feedback/reflection
    ) -> List[SkillGenome]:
        """
        Generate new variants based on the diagnoses.
        Supports both simple LLM calls and Tool-Calling Agent logic.
        """
        if not diagnoses and not reflection:
            print(
                ">>> No diagnoses and no reflection provided. Returning parent genome."
            )
            return [parent]

        # 1. Format Diagnosis List for Prompt
        diagnosis_text = ""
        for i, d in enumerate(diagnoses):
            diagnosis_text += f"{i+1}. [{d.dimension}] {d.description}\n   Fix Suggestion: {d.suggested_fix}\n"

        if not diagnosis_text:
            diagnosis_text = (
                "No automated diagnoses found. Please refer to Human Feedback."
            )

        # 2. Construct Prompt
        current_skill_text = parent.to_markdown()

        # Add list of existing files to context
        existing_files = "\n".join(parent.files.keys())
        file_context = (
            f"\n# Existing Auxiliary Files:\n{existing_files}\n"
            if existing_files
            else ""
        )

        prompt = GENERAL_FIX_PROMPT.format(
            skill_content=current_skill_text + file_context,
            diagnosis_list=diagnosis_text,
        )

        # Inject Human Feedback if available
        if (
            reflection
            and reflection.strip()
            and reflection != "Combined diagnostics..."
        ):
            feedback_section = HUMAN_FEEDBACK_TEMPLATE.format(content=reflection)
            # Append to the end of the prompt or insert before Task
            # Appending to end is usually fine as it's the last thing the LLM reads (Recency Bias)
            prompt += feedback_section
            print(">>> Injected Human Feedback into Prompt.")

        print(
            f">>> Calling Mutator LLM to fix {len(diagnoses)} issues (Feedback present: {bool(reflection)})..."
        )

        # 3. Choose Execution Mode
        if hasattr(self.model_client, "llm"):
            # Agentic Mode (Tool Calling)
            return self._mutate_with_tools(parent, prompt, trace_id=trace_id)
        else:
            # Legacy Mode (String only)
            return self._mutate_legacy(parent, prompt)

    def _mutate_with_tools(
        self, parent: SkillGenome, prompt: str, trace_id: Optional[str] = None
    ) -> List[SkillGenome]:
        """
        Agentic Mutation Loop using LangChain Agents (create_agent).
        """
        # Clone parent
        new_genome = SkillGenome(
            name=parent.name,
            raw_text=parent.raw_text,
            files=parent.files.copy(),
            file_meta=parent.file_meta.copy(),
            changelog=list(parent.changelog),
        )

        file_chunks: dict[str, dict[int, str]] = {}
        file_totals: dict[str, int] = {}
        file_summaries: dict[str, str] = {}

        def normalize_path(path: str) -> str:
            p = (path or "").strip()
            if p.startswith("./"):
                p = p[2:]
            return p

        def reset_round_files() -> None:
            file_chunks.clear()
            file_totals.clear()
            file_summaries.clear()

        def get_missing_chunks(path: str) -> list[int] | None:
            p = normalize_path(path)
            total = file_totals.get(p)
            if total is None:
                return None
            have = file_chunks.get(p, {})
            return [i for i in range(1, total + 1) if i not in have]

        def assemble_file(path: str) -> str | None:
            p = normalize_path(path)
            total = file_totals.get(p)
            if not total:
                return None
            missing = get_missing_chunks(p)
            if missing is None or missing:
                return None
            return "".join(file_chunks[p][i] for i in range(1, total + 1))

        def apply_assembled_files() -> None:
            for p in list(file_totals.keys()):
                content = assemble_file(p)
                if content is None:
                    continue
                if p == "SKILL.md":
                    new_genome.raw_text = content
                    try:
                        parsed = SkillGenome.from_markdown(content)
                        new_genome.name = parsed.name
                    except Exception:
                        pass
                    continue
                new_genome.files[p] = content
                summary = file_summaries.get(p)
                if summary:
                    new_genome.file_meta[p] = summary

        def validate_writable_path(path: str) -> str | None:
            p = normalize_path(path)
            if p == "SKILL.md":
                return None
            if p.startswith("scripts/") or p.startswith("references/"):
                return None
            return "Only SKILL.md, scripts/*, and references/* are allowed."

        @tool
        def write_file_chunk(
            path: str,
            index: int,
            total: int,
            content: str,
            summary: str = "",
        ):
            """
            Write a chunk of a file. Supports large files via (index, total) chunks.
            - path="SKILL.md" updates the main skill definition.
            - path starts with scripts/ or references/ updates auxiliary files.

            Args:
                path: Target relative path (SKILL.md, scripts/..., references/...).
                index: 1-based chunk index.
                total: Total number of chunks (must be consistent across calls for the same path).
                content: Raw file content for this chunk (no markdown fences).
                summary: Required for scripts/* and references/* (one-line purpose/usage or doc summary).
            """
            p = normalize_path(path)
            err = validate_writable_path(p)
            if err:
                return f"Error: {err}"
            if total < 1:
                return "Error: total must be >= 1"
            if index < 1 or index > total:
                return f"Error: index must be between 1 and {total}"

            if (p.startswith("scripts/") or p.startswith("references/")) and p not in file_summaries:
                if not (summary or "").strip():
                    return "Error: summary is required for scripts/* and references/*."
                file_summaries[p] = summary.strip()
            elif (summary or "").strip() and p not in file_summaries and p != "SKILL.md":
                file_summaries[p] = summary.strip()

            existing_total = file_totals.get(p)
            if existing_total is None:
                file_totals[p] = total
            elif existing_total != total:
                return f"Error: total changed for {p} (was {existing_total}, now {total})."

            if p not in file_chunks:
                file_chunks[p] = {}
            if index in file_chunks[p]:
                logger.warning(f"Chunk overwrite rejected for {p} index={index}.")
                return f"Warning: chunk {index}/{total} for {p} already received. Skip it."

            file_chunks[p][index] = content
            received = sorted(file_chunks[p].keys())
            return f"Saved {p} chunk {index}/{total}. Received: {received}"

        @tool
        def record_fix(diagnosis_index: int, description: str, changed_sections: str):
            """
            Record a fix action in the changelog.
            MUST be called whenever you address a diagnosis.

            Args:
                diagnosis_index: The index of the diagnosis (from the provided list, starting at 1).
                description: A brief explanation of what was fixed and why.
                changed_sections: Which sections (e.g., 'Instruction', 'Risk') were modified.
            """
            new_genome.changelog.append(
                {
                    "diagnosis_index": str(diagnosis_index),
                    "description": description,
                    "changed_sections": changed_sections,
                }
            )
            return f"Recorded fix for Diagnosis #{diagnosis_index}."

        @tool
        def delete_file(path: str):
            """Delete an auxiliary file (scripts/* or references/*)."""
            p = normalize_path(path)
            if p == "SKILL.md":
                return "Error: SKILL.md cannot be deleted."
            if p in new_genome.files:
                del new_genome.files[p]
                if p in new_genome.file_meta:
                    del new_genome.file_meta[p]
                return f"Successfully deleted {p}."
            return f"File {p} not found."

        tools = [
            write_file_chunk,
            delete_file,
            record_fix,
        ]

        def extract_referenced_paths(skill_md: str) -> set[str]:
            import re

            if not skill_md:
                return set()
            matches = re.findall(
                r"\b(?:scripts|references)/[A-Za-z0-9._/\-]+\.[A-Za-z0-9]+\b", skill_md
            )
            return set(matches)

        # Remove apply_skill_md_from_text as it is no longer used in Agent mode


        def run_agent_round(round_prompt: str) -> tuple[str, object | None]:
            callbacks = []
            ai_messages: list[str] = []
            last_non_tool_msg: object | None = None
            for event in agent_graph.stream(
                {"messages": [HumanMessage(content=round_prompt)]},
                stream_mode="updates",
                config={"callbacks": callbacks},
            ):
                for _, updates in event.items():
                    if "messages" not in updates:
                        continue
                    last_msg = updates["messages"][-1]
                    if getattr(last_msg, "tool_calls", None):
                        print(
                            f"\n[Agent Thought]: Decided to call {len(last_msg.tool_calls)} tools:"
                        )
                        for tc in last_msg.tool_calls:
                            print(f"  - Tool: {tc['name']}")
                            print(f"    Args: {tc['args']}")
                        continue

                    if getattr(last_msg, "tool_call_id", None):
                        print(
                            f"\n[Tool Result]: {last_msg.content[:200]}..."
                            if len(last_msg.content) > 200
                            else f"\n[Tool Result]: {last_msg.content}"
                        )
                        continue

                    if hasattr(last_msg, "content") and last_msg.content:
                        ai_messages.append(last_msg.content)
                        last_non_tool_msg = last_msg
                        print(
                            f"\n[Agent Message]: {last_msg.content[:200]}..."
                            if len(last_msg.content) > 200
                            else f"\n[Agent Message]: {last_msg.content}"
                        )

            if not ai_messages:
                return "", last_non_tool_msg
            return "\n\n".join(ai_messages), last_non_tool_msg

        def extract_headings(md: str) -> list[str]:
            import re

            out: list[str] = []
            for line in (md or "").splitlines():
                m = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
                if not m:
                    continue
                title = m.group(2).strip()
                if not title:
                    continue
                out.append(f"{m.group(1)} {title}")
            return out

        def looks_truncated(extracted: str) -> bool:
            if self._raw_has_unclosed_markdown_fence(extracted):
                return True
            if self._has_suspicious_colon_leadin(extracted):
                return True
            parent_headings = extract_headings(parent.raw_text)
            if not parent_headings:
                return False
            extracted_headings = set(extract_headings(extracted))
            step_like = [h for h in parent_headings if "步骤" in h]
            required = step_like if step_like else [h for h in parent_headings if h.startswith("## ")]
            required = [h for h in required if h not in {"## File references"}]
            if not required:
                return False
            missing = [h for h in required if h not in extracted_headings]
            if step_like and missing:
                return True
            if len(missing) / max(len(required), 1) >= 0.3:
                return True
            return False

        def retry_for_completeness(previous_extracted: str) -> bool:
            # Removed in favor of chunk missing retry logic
            return False

        try:
            agent_graph = create_agent(
                model=self.model_client.llm,
                tools=tools,
                system_prompt=MUTATOR_SYSTEM_PROMPT,
            )

            logger.info(">>> Starting Agentic Mutation Loop (Graph)...")

            max_rounds = int(os.getenv("SKILL_OPT_MUTATOR_MAX_ROUNDS", "2") or "2")
            missing: list[str] = []
            last_agent_text = ""

            for round_index in range(max_rounds):
                round_prompt = prompt if round_index == 0 else (
                    "You MUST fix the missing auxiliary files referenced by SKILL.md.\n"
                    "Requirements:\n"
                    "- For EACH missing file, call write_file_chunk(path, index, total, content, summary).\n"
                    "  - If the file is small, use index=1 and total=1.\n"
                    "- Keep SKILL.md content consistent; only adjust references if necessary.\n"
                    "- Write the COMPLETE updated SKILL.md using write_file_chunk(path='SKILL.md', index, total, content).\n\n"
                    f"# Missing files:\n{os.linesep.join(f'- {p}' for p in missing)}\n\n"
                    f"# Current SKILL.md:\n```markdown\n{new_genome.raw_text}\n```\n"
                )

                reset_round_files()
                last_agent_text, last_agent_msg = run_agent_round(round_prompt)

                chunk_retries = int(os.getenv("SKILL_OPT_MUTATOR_CHUNK_RETRY", "2") or "2")
                for _ in range(chunk_retries):
                    if "SKILL.md" not in file_totals:
                        followup_prompt = (
                            "You did not write SKILL.md.\n"
                            "Write the COMPLETE updated SKILL.md using write_file_chunk(path='SKILL.md', index, total, content).\n"
                            "Do NOT output any part of SKILL.md in your message.\n"
                            "Use the following as the source of truth:\n\n"
                            f"{prompt}\n"
                        )
                        run_agent_round(followup_prompt)
                        continue
                    missing_chunks = get_missing_chunks("SKILL.md")
                    if missing_chunks is None:
                        break
                    if not missing_chunks:
                        break
                    missing_str = ", ".join(str(i) for i in missing_chunks[:100])
                    followup_prompt = (
                        "The SKILL.md update is incomplete.\n"
                        f"Missing chunk indices: {missing_str}\n"
                        f"Total chunks: {file_totals.get('SKILL.md')}\n"
                        "Write ONLY the missing SKILL.md chunks using write_file_chunk(path='SKILL.md', index, total, content).\n"
                        "Do NOT rewrite chunks that were already received.\n"
                        "Do NOT output any part of SKILL.md in your message.\n"
                        "Use the following as the source of truth:\n\n"
                        f"{prompt}\n"
                    )
                    run_agent_round(followup_prompt)

                apply_assembled_files()
                assembled_skill = new_genome.raw_text
                if not assembled_skill or "SKILL.md" not in file_totals or assemble_file("SKILL.md") is None:
                    logger.error(
                        f"Mutator agent failed to provide all SKILL.md chunks. Missing: {get_missing_chunks('SKILL.md')}"
                    )
                    logger.info(f"Raw agent output for failed chunks: {last_agent_text}")
                    return [parent]

                referenced = extract_referenced_paths(new_genome.raw_text)
                missing = sorted([p for p in referenced if p not in new_genome.files])
                if not missing:
                    break
                logger.warning(f"Mutator agent referenced missing auxiliary files: {missing}")

            if missing:
                logger.warning(
                    f"Mutator failed to repair missing files after {max_rounds} rounds; returning parent genome."
                )
                return [parent]

            print(">>> Agentic Loop Completed.")

        except Exception as e:
            print(f"!!! Agent Execution Error: {e}")
            import traceback

            traceback.print_exc()

        return [new_genome]

    def _mutate_legacy(self, parent: SkillGenome, prompt: str) -> List[SkillGenome]:
        """
        Legacy String-based Mutation.
        """
        if self.model_client:
            try:
                response = self.model_client(prompt)
                raw_text = response.content if hasattr(response, "content") else str(
                    response
                )
                new_content = self._extract_markdown(raw_text)
                self._log_skill_md_extraction_diagnostics(
                    extracted=new_content, raw_text=raw_text, last_msg=response
                )
                new_genome = SkillGenome.from_markdown(new_content)
                new_genome.files = parent.files.copy()
                new_genome.file_meta = parent.file_meta.copy()
                return [new_genome]
            except Exception as e:
                print(f"!!! Mutation failed: {e}")
                return [parent]
        else:
            print("!!! No model_client provided to Mutator. Skipping LLM call.")
            return [parent]

    def _extract_markdown(self, text: str) -> str:
        """
        Extract content from markdown code blocks if present anywhere in the text.
        Handles nested code blocks by extracting the best matching block using a line-by-line state machine.
        """
        text = text.strip()

        def looks_like_skill_md(body: str) -> bool:
            import re
            b = body.lstrip()
            if b.startswith("---") and re.search(r"(?m)^name:\s*\S+", b):
                return True
            if "# Role" in body or "# Instruction" in body or "# Workflow" in body:
                return True
            if re.search(r"(?m)^#\s+\S+", body):
                return True
            return False

        def looks_like_plan(body: str) -> bool:
            b = body.lstrip()
            if b.startswith("PLAN\n") or b.startswith("PLAN\r\n"):
                return True
            if "Diagnosis Grouping:" in body and "PLAN" in body.splitlines()[0:3]:
                return True
            return False

        blocks: list[tuple[str, str]] = []
        
        # State machine parsing
        in_block = False
        fence_char = ""
        fence_len = 0
        lang_tag = ""
        current_lines: list[str] = []
        
        import re
        lines = text.splitlines()
        for line in lines:
            if not in_block:
                m = re.match(r"^\s*(?P<fence>`{3,}|~{3,})(?:\s*(?P<lang>[a-zA-Z0-9_-]+))?\s*$", line)
                if m:
                    in_block = True
                    fence_str = m.group("fence")
                    fence_char = fence_str[0]
                    fence_len = len(fence_str)
                    lang_tag = (m.group("lang") or "").strip().lower()
                    current_lines = []
            else:
                m = re.match(r"^\s*(?P<fence>`{3,}|~{3,})\s*$", line)
                if m:
                    fence_str = m.group("fence")
                    # Closing fence must use the same character and be AT LEAST as long as opening fence
                    if fence_str[0] == fence_char and len(fence_str) >= fence_len:
                        blocks.append((lang_tag, "\n".join(current_lines)))
                        in_block = False
                        continue
                current_lines.append(line)
        
        # If text ends while still in_block, save it as truncated block
        if in_block:
            blocks.append((lang_tag, "\n".join(current_lines)))

        best_body = ""
        best_score = -10_000
        for lang, body in blocks:
            if not body:
                continue
            score = 0
            if lang == "markdown":
                score += 20
            if looks_like_skill_md(body):
                score += 15
            if looks_like_plan(body):
                score -= 1000
            if lang in {"bash", "sh", "shell", "zsh", "json", "yaml", "yml"}:
                score -= 5
            score += min(len(body) // 200, 10)
            if score > best_score:
                best_score = score
                best_body = body

        if best_body and looks_like_skill_md(best_body):
            return best_body.strip()

        # Fallback: if no valid blocks found, just return text (might be plain text response)
        return text.strip()

    def _log_skill_md_extraction_diagnostics(
        self,
        *,
        extracted: str,
        raw_text: str,
        last_msg: object | None = None,
    ) -> None:
        if not extracted:
            return

        token_usage = None
        finish_reason = None
        response_metadata = getattr(last_msg, "response_metadata", None)
        if isinstance(response_metadata, dict):
            token_usage = (
                response_metadata.get("token_usage")
                or response_metadata.get("usage")
                or response_metadata.get("tokenUsage")
            )
            finish_reason = (
                response_metadata.get("finish_reason")
                or response_metadata.get("finishReason")
                or response_metadata.get("stop_reason")
                or response_metadata.get("stopReason")
            )

        max_tokens = None
        llm = getattr(self.model_client, "llm", None)
        if llm is not None:
            max_tokens = getattr(llm, "max_tokens", None)

        lines = extracted.strip().splitlines()
        last_line = lines[-1] if lines else ""

        print(f"[Mutator Token Usage]: {token_usage} (max_tokens={max_tokens})")
        if finish_reason is not None:
            print(f"[Mutator Finish Reason]: {finish_reason}")
        print(f"[Last line of extracted SKILL.md]: {last_line!r}")

        if self._raw_has_unclosed_markdown_fence(raw_text):
            logger.warning(
                "Mutator output appears to have an unclosed markdown fence (possible truncation)."
            )

        last = last_line.strip()
        if last.startswith("#") or last.endswith(":"):
            logger.warning(
                "Extracted SKILL.md appears to end at an unstable boundary (possible early stop)."
            )

    @staticmethod
    def _raw_has_unclosed_markdown_fence(raw_text: str) -> bool:
        import re

        if not raw_text:
            return False
            
        in_block = False
        fence_char = ""
        fence_len = 0
        
        for line in raw_text.splitlines():
            if not in_block:
                m = re.match(r"^\s*(?P<fence>`{3,}|~{3,})(?:\s*[a-zA-Z0-9_-]+)?\s*$", line)
                if m:
                    in_block = True
                    fence_str = m.group("fence")
                    fence_char = fence_str[0]
                    fence_len = len(fence_str)
            else:
                m = re.match(r"^\s*(?P<fence>`{3,}|~{3,})\s*$", line)
                if m:
                    fence_str = m.group("fence")
                    if fence_str[0] == fence_char and len(fence_str) >= fence_len:
                        in_block = False
        
        return in_block

    @staticmethod
    def _has_suspicious_colon_leadin(md: str) -> bool:
        import re

        if not md:
            return False
        lines = md.splitlines()
        for i, line in enumerate(lines):
            if not re.match(r"^\s*(?:\d+\.|-)\s+.+[：:]\s*$", line):
                continue
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j >= len(lines) or lines[j].lstrip().startswith("#"):
                return True
        return False
