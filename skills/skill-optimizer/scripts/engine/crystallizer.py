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
from typing import Any, Dict, List

from architecture.genome import SkillGenome
from architecture.scoring import Diagnosis
from engine.mutator import DiagnosticMutator


class ReportParser:
    """
    Parses the unstructured/semi-structured text reports from the runner using LLM.
    Avoids brittle regex by relying on the model to structure the data.
    """

    def __init__(self, model_client=None):
        self.model_client = model_client  # e.g. DeepSeek/OpenAI client

    def parse_skill_issues(self, issue_text: str) -> List[Dict[str, str]]:
        """
        Extract specific mutation requests from 'skill_issues' text.
        Returns a list of dicts: {'dimension': '...', 'problem': '...', 'fix_suggestion': '...'}
        """
        if not issue_text or "None" in issue_text:
            return []

        prompt = f"""
You are an expert parsing assistant. 
Your task is to extract structured issues from the following "Skill Analysis" text.
Focus ONLY on issues that require changing the Skill Definition (e.g., instruction, constraints, examples).
Ignore issues that are purely runtime transient errors unless they suggest a skill improvement.

Input Text:
\"\"\"
{issue_text}
\"\"\"

Output Format (JSON List):
[
  {{
    "dimension": "Instruction" | "Structure" | "Content" | "Risk",
    "problem": "Brief description of the problem",
    "fix_suggestion": "Specific suggestion on how to fix the skill text"
  }}
]
Just return the JSON.
"""
        # Placeholder for LLM call
        # In real implementation, replace with self.model_client.chat(...)
        # For now, we simulate a response based on the user's example if strictly needed,
        # but here we should implement the actual call mechanism if model_client is available.
        # Since I don't have the client instance here, I will structure this to use a helper function
        # or assume the user will inject the client.

        # NOTE: For this skeleton, I will use a dummy return or expect the caller to mock it.
        # To make it runnable, I'll add a check.
        if self.model_client:
            response = self.model_client(prompt)  # Abstract call
            return self._clean_json(response)

        return []

    def parse_failures(self, failure_text: str) -> List[Dict[str, str]]:
        """
        Extract constraints/rules from 'failures' (Intermediate Anomalies).
        """
        if not failure_text or "None" in failure_text:
            return []

        prompt = f"""
You are an expert parsing assistant.
Analyze the following "Intermediate Failures / Anomalies" from an agent execution.
Determine if any failures suggest a need for a new CONSTRAINT or RULE in the skill definition to prevent recurrence.

Input Text:
\"\"\"
{failure_text}
\"\"\"

Output Format (JSON List):
[
  {{
    "dimension": "Risk" | "Instruction", 
    "problem": "Tool Error: ...",
    "new_rule": "Constraint to add (e.g., 'Check if file exists before reading')"
  }}
]
Just return the JSON.
"""
        if self.model_client:
            response = self.model_client(prompt)
            return self._clean_json(response)
        return []

    def _clean_json(self, text: str) -> List[Dict]:
        # Simple cleaner
        try:
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]
            return json.loads(text.strip())
        except:
            return []


class ExperienceCrystallizer:
    """
    The 'Dynamic Run' Engine.
    Ingests reports -> Parses -> Mutates Skill.
    """

    def __init__(self, parser: ReportParser, mutator: DiagnosticMutator):
        self.parser = parser
        self.mutator = mutator

    def crystallize(
        self, genome: SkillGenome, report_items: List[Dict[str, Any]]
    ) -> tuple[SkillGenome, list]:
        """
        Main entry point for "Dynamic Run" optimization.

        Returns:
            tuple: (optimized_genome, diagnoses)
        """
        all_diagnoses = []

        for i, report_item in enumerate(report_items):
            print(
                f">>> Crystallizing Experience for Query [{i+1}/{len(report_items)}]: {report_item.get('query', '')[:50]}..."
            )

            # 2. Extract Issues (Skill Analysis)
            skill_issues = report_item.get("skill_issues", "")
            parsed_issues = self.parser.parse_skill_issues(skill_issues)

            # 3. Extract Failures (Anomalies)
            failures = report_item.get("failures", "")
            parsed_failures = self.parser.parse_failures(failures)

            for issue in parsed_issues:
                print(
                    f"    [Issue] {issue['problem']} -> {issue['fix_suggestion'][:50]}..."
                )
                all_diagnoses.append(
                    Diagnosis(
                        dimension=issue["dimension"],
                        issue_type="SkillDefect",
                        severity="Major",
                        description=issue["problem"],
                        evidence=skill_issues,
                        suggested_fix=issue["fix_suggestion"],
                    )
                )

            for fail in parsed_failures:
                print(
                    f"    [Failure] {fail['problem']} -> Rule: {fail['new_rule'][:50]}..."
                )
                all_diagnoses.append(
                    Diagnosis(
                        dimension=fail["dimension"],
                        issue_type="RuntimeAnomaly",
                        severity="Minor",
                        description=fail["problem"],
                        evidence=failures,
                        suggested_fix=f"Add constraint: {fail['new_rule']}",
                    )
                )

        if not all_diagnoses:
            print(">>> No actionable issues found in any report.")
            return genome, []

        # 5. Apply Mutations
        # We use the existing DiagnosticMutator logic
        print(">>> Applying mutations to skill...")
        variants = self.mutator.mutate(genome, all_diagnoses)

        if variants:
            print(">>> Optimization applied successfully.")
            return variants[0], all_diagnoses

        return genome, all_diagnoses
