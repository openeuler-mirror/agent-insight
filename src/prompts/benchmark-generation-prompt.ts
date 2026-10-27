/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

interface SkillBenchmarkPromptInput {
  skillName: string;
  skillVersion: number | null;
  skillDescription?: string | null;
  skillCategory?: string | null;
  changeLog?: string | null;
  auxiliarySummaries?: string[];
  skillContent: string;
}

interface RoutingPromptInput extends SkillBenchmarkPromptInput {
  count: number;
  existingQueries?: string[];
}

export function generateRoutingBenchmarkPrompt(input: RoutingPromptInput): string {
  const {
    skillName,
    skillVersion,
    skillDescription,
    skillCategory,
    changeLog,
    auxiliarySummaries = [],
    skillContent,
    count,
    existingQueries = [],
  } = input;

  const auxiliarySection = auxiliarySummaries.length > 0
    ? auxiliarySummaries.map(item => `- ${item}`).join('\n')
    : '- None';

  const existingQuerySection = existingQueries.length > 0
    ? existingQueries.map(item => `- ${item}`).join('\n')
    : '- None';

  return `
You are the routing benchmark generator for an AI skill system.

Your task is to generate routing benchmarks for one target skill. A routing benchmark is a user query that SHOULD route to the target skill as the expected skill.

Target Skill:
- Name: ${skillName}
- Version: ${skillVersion != null ? `v${skillVersion}` : 'unversioned'}
- Category: ${skillCategory || 'Unknown'}
- Description: ${skillDescription || 'No description provided'}
- Change Log: ${changeLog || 'No change log provided'}

Auxiliary Files Summary:
${auxiliarySection}

Existing routing queries already associated with this skill:
${existingQuerySection}

Skill Definition (SKILL.md):
\`\`\`md
${skillContent}
\`\`\`

Generate exactly ${count} semantically distinct routing benchmark queries.

Return ONLY JSON in this format:
{
  "benchmarks": [
    {
      "query": "realistic user query",
      "coverage": "short note on which responsibility slice this query covers"
    }
  ]
}

Rules:
- Every query must genuinely require the target skill.
- Generate queries, not answers, plans, or evaluation explanations.
- Cover different parts of the skill's capability surface instead of paraphrasing the same request.
- Prefer concise, realistic user wording.
- Do not copy the wording of existing queries.
- Do not invent responsibilities that are not supported by the skill definition.
- Use the same primary language as the skill definition.
`.trim();
}

export function generateOutcomeBenchmarkPrompt(input: SkillBenchmarkPromptInput): string {
  const {
    skillName,
    skillVersion,
    skillDescription,
    skillCategory,
    changeLog,
    auxiliarySummaries = [],
    skillContent,
  } = input;

  const auxiliarySection = auxiliarySummaries.length > 0
    ? auxiliarySummaries.map(item => `- ${item}`).join('\n')
    : '- None';

  return `
You are the outcome benchmark generator for an AI skill system.

Your task is to generate one execution-level benchmark for a target skill. The benchmark should capture what a correct final outcome looks like when this skill is used successfully.

Target Skill:
- Name: ${skillName}
- Version: ${skillVersion != null ? `v${skillVersion}` : 'unversioned'}
- Category: ${skillCategory || 'Unknown'}
- Description: ${skillDescription || 'No description provided'}
- Change Log: ${changeLog || 'No change log provided'}

Auxiliary Files Summary:
${auxiliarySection}

Skill Definition (SKILL.md):
\`\`\`md
${skillContent}
\`\`\`

Return ONLY JSON in this format:
{
  "benchmark": {
    "sourceScenario": "optional concise scenario title or example request",
    "standardAnswer": "reference output in markdown or plain text"
  }
}

Rules:
- The standardAnswer must reflect the real deliverable this skill is responsible for producing.
- The standardAnswer must be detailed enough to support later extraction of key points and key actions.
- The sourceScenario is optional metadata. It is not the scoring key.
- Do not invent capabilities outside the skill definition.
- Use the same primary language as the skill definition.
`.trim();
}
