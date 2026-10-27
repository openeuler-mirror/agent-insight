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

import re
import yaml
from typing import List, Optional
from architecture.scoring import Diagnosis

class SkillLinter:
    """
    Static Rule-based Linter for Skill Content.
    Performs hard compliance checks before LLM evaluation.
    """
    
    def lint(self, content: str) -> List[Diagnosis]:
        """
        Run all static checks.
        Returns a list of Diagnosis objects for any violations found.
        """
        diagnoses = []
        
        # 1. Length Check
        # Progressive Disclosure: Keep skills concise.
        if len(content) > 5000:
             diagnoses.append(Diagnosis(
                dimension="Structure",
                issue_type="ComplianceViolation",
                severity="Minor",
                description="Skill content exceeds 5000 characters. Consider moving details to external reference files (Progressive Disclosure).",
                evidence=f"Current length: {len(content)} chars",
                suggested_fix="Split long content into separate markdown files in a 'references/' directory."
            ))

        # 2. YAML Frontmatter Check
        # Check if content starts with YAML block
        frontmatter = self._extract_frontmatter(content)
        if not frontmatter:
             diagnoses.append(Diagnosis(
                dimension="Structure",
                issue_type="ComplianceViolation",
                severity="Major",
                description="Missing YAML Frontmatter. Skill must start with '---' block.",
                evidence="No YAML block found at the beginning of file.",
                suggested_fix="Add YAML frontmatter with 'name' and 'description' fields."
            ))
        else:
            # Validate YAML syntax and required fields
            try:
                data = yaml.safe_load(frontmatter)
                if not isinstance(data, dict):
                    raise ValueError("Frontmatter is not a dictionary.")
                
                # Check required fields
                if "name" not in data:
                     diagnoses.append(Diagnosis(
                        dimension="Role",
                        issue_type="ComplianceViolation",
                        severity="Critical",
                        description="Missing 'name' field in YAML frontmatter.",
                        evidence=frontmatter,
                        suggested_fix="Add 'name: <skill-name>' to frontmatter."
                    ))
                
                if "description" not in data:
                     diagnoses.append(Diagnosis(
                        dimension="Role",
                        issue_type="ComplianceViolation",
                        severity="Critical",
                        description="Missing 'description' field in YAML frontmatter.",
                        evidence=frontmatter,
                        suggested_fix="Add 'description: ...' to frontmatter."
                    ))
                    
                # Check Naming Convention (kebab-case)
                if "name" in data:
                    name = data["name"]
                    if not re.match(r"^[a-z0-9-]+$", name):
                         diagnoses.append(Diagnosis(
                            dimension="Role",
                            issue_type="ComplianceViolation",
                            severity="Minor",
                            description=f"Skill name '{name}' is not in kebab-case.",
                            evidence=f"name: {name}",
                            suggested_fix="Rename to lowercase with hyphens (e.g., 'my-skill-name')."
                        ))

            except yaml.YAMLError as e:
                 diagnoses.append(Diagnosis(
                    dimension="Structure",
                    issue_type="ComplianceViolation",
                    severity="Critical",
                    description="Invalid YAML Frontmatter syntax.",
                    evidence=str(e),
                    suggested_fix="Fix YAML syntax errors."
                ))

        # 3. Header Structure Check
        # Ensure key sections exist
        required_headers = [] # eg. ["Role", "Instruction"]
        for header in required_headers:
            if not re.search(f"^##\\s+{header}", content, re.MULTILINE | re.IGNORECASE) and \
               not re.search(f"^#\\s+{header}", content, re.MULTILINE | re.IGNORECASE): 
               # Check specifically for Instructions alias
               if header == "Instruction" and (re.search(f"^##\\s+Instructions", content, re.MULTILINE | re.IGNORECASE) or \
                                               re.search(f"^#\\s+Instructions", content, re.MULTILINE | re.IGNORECASE)):
                   continue

               diagnoses.append(Diagnosis(
                    dimension="Structure",
                    issue_type="ComplianceViolation",
                    severity="Major",
                    description=f"Missing required section: '## {header}'.",
                    evidence="Header not found.",
                    suggested_fix=f"Add a '## {header}' section."
                ))

        return diagnoses

    def _extract_frontmatter(self, content: str) -> Optional[str]:
        """
        Extract content between the first two '---' lines.
        """
        # Simple regex for frontmatter
        match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
        if match:
            return match.group(1)
        return None
