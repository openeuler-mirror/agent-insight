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

from typing import List
from architecture.genome import SkillGenome
from architecture.scoring import Diagnosis
from langchain_core.messages import HumanMessage

REPORT_PROMPT = """
You are an expert technical writer and code reviewer.
Your task is to generate a comprehensive "Optimization Report" (CHANGELOG) for a Skill improvement process.

# Input Data

1. **Original Skill Genome**:
{original_skill}

2. **Optimized Skill Genome**:
{optimized_skill}

3. **Diagnoses (Issues Found)**:
{diagnoses_text}

# Task
Generate a Markdown report named `OPTIMIZATION_REPORT.md`.
The report should include:

1. **Executive Summary**: A brief overview of the optimization focus (e.g., "Fixed security risks and improved error handling").
2. **Diagnosis Summary**: A table or list summarizing the key issues identified (Severity, Type, Description).
3. **Detailed Changelog**:
   - List the specific changes made to the Skill content (Role, Structure, Instructions, etc.).
   - **Crucially**, explain *WHY* each change was made, referencing the specific Diagnosis that triggered it.
   - If auxiliary files were added/modified, list them and explain their purpose.
4. **Before/After Diff Highlights**:
   - Show key snippets of "Before" vs "After" to demonstrate the improvement (e.g., how a specific rule was rewritten).

# Format
- Use standard Markdown.
- Be professional, concise, and educational.
- Use emojis where appropriate to make it readable (e.g., 🐛 for bugs, ✅ for fixes).
- Language: Chinese (Simplified) as per user preference.
"""


class OptimizationReportGenerator:
    def __init__(self, model_client):
        self.model_client = model_client

    def generate_report(
        self, original: SkillGenome, optimized: SkillGenome, diagnoses: List[Diagnosis]
    ) -> str:
        """
        Generate a human-readable optimization report.
        """
        if not self.model_client:
            return "No LLM client provided. Cannot generate report."

        # Format Diagnoses with Changelog mapping
        # We try to match diagnoses to changelog entries if possible

        changelog_map = {
            entry["diagnosis_index"]: entry for entry in optimized.changelog
        }

        diagnoses_text = ""
        for i, d in enumerate(diagnoses):
            idx = str(i + 1)
            status = "❌ Not Fixed"
            fix_details = ""

            if idx in changelog_map:
                status = "✅ Fixed"
                entry = changelog_map[idx]
                fix_details = f"\n   - Action: {entry['description']}\n   - Sections: {entry['changed_sections']}"

            diagnoses_text += f"{idx}. [{d.severity}] {d.dimension}: {d.description}\n   Status: {status}{fix_details}\n"

        prompt = REPORT_PROMPT.format(
            original_skill=original.to_markdown(),
            optimized_skill=optimized.to_markdown(),
            diagnoses_text=diagnoses_text,
        )

        try:
            print(">>> Generating Optimization Report...")
            # Use invoke if available (LangChain), else direct call
            if hasattr(self.model_client, "llm"):
                response = self.model_client.llm.invoke([HumanMessage(content=prompt)])
                return response.content
            elif callable(self.model_client):
                return self.model_client(prompt)
            else:
                return "Invalid model_client."
        except Exception as e:
            return f"Failed to generate report: {e}"
