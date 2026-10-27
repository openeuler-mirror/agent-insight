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


interface CriteriaItem {
  id: string;
  weight: number;
  content: string;
  controlFlowType?: 'required' | 'conditional' | 'loop' | 'optional' | 'handoff';
  condition?: string;
  branchLabel?: string;
  loopCondition?: string;
  expectedMinCount?: number;
  expectedMaxCount?: number;
}

export function generateJudgePrompt(
  userQuery: string,
  actualAnswer: string,
  rcList: CriteriaItem[],
  kaList: CriteriaItem[],
  skillDefinition?: string,
  mode?: 'root_causes' | 'key_actions',
  executionStepsText?: string | null
): string {
  const skillSection = skillDefinition 
    ? `Reference Skill Definition (Using this skill as the context for evaluation):\n${skillDefinition}\n\n` 
    : '';

  const formatKa = (ka: CriteriaItem) => {
    let suffix = '';
    if (ka.controlFlowType === 'optional') {
      suffix = ' [可选 - 未执行不扣分]';
    } else if (ka.controlFlowType === 'conditional') {
      suffix = ` [条件分支 - ${ka.branchLabel || ka.condition || ''}]`;
    } else if (ka.controlFlowType === 'loop') {
      suffix = ` [循环 - ${ka.loopCondition || ''}, 预期${ka.expectedMinCount ?? '?'}~${ka.expectedMaxCount ?? '?'}次]`;
    } else if (ka.controlFlowType === 'handoff') {
      suffix = ' [衔接 - 技能间转换]';
    }
    return `   - [ID: ${ka.id}] [Weight: ${ka.weight}] ${ka.content}${suffix}`;
  };

  if (mode === 'root_causes') {
    return `
You are an objective and strict judge. Your task is evaluate "Root Causes" against the "User Answer" for a given "User Query".

${skillSection}User Query: ${userQuery}
User Answer: ${actualAnswer}

Evaluation Criteria - Root Causes (Must identify these issues):
${rcList.map(rc => `   - [ID: ${rc.id}] [Weight: ${rc.weight}] ${rc.content}`).join('\n') || '   (None)'}

Evaluation Steps:
1. For each Root Cause listed above (marked with [ID: ...]), determine the degree of match (0.0 to 1.0) based on the User Answer.
   - 0.0 = Not mentioned or completely wrong.
   - 0.5 = Partially mentioned or vague.
   - 1.0 = Clearly and correctly addressed.
2. Provide a brief explanation (in Chinese) for your evaluation of each item.

Respond ONLY with a JSON object in the following format:
{
  "evaluations": [
    { "id": "RC-0", "match_score": 0.5, "explanation": "此处用中文简要解释评分理由..." }
    ...
  ]
}
`;
  }

  if (mode === 'key_actions') {
    const stepsSection = executionStepsText
      ? `Execution Steps (actual steps extracted from the execution trace):\n${executionStepsText}\n\n`
      : '';

    const answerSection = executionStepsText
      ? `Please evaluate each Key Action based on the Execution Steps above. Determine whether each action was actually performed during execution.`
      : `User Answer: ${actualAnswer}\n\nPlease evaluate each Key Action based on the User Answer above.`;

    return `
You are an objective and strict judge. Your task is to evaluate "Key Actions" against the execution trace for a given "User Query".

${skillSection}User Query: ${userQuery}
${stepsSection}${answerSection}

Evaluation Criteria - Key Actions:
${kaList.map(ka => formatKa(ka)).join('\n') || '   (None)'}

Evaluation Steps:
1. For each Key Action listed above (marked with [ID: ...]), determine the degree of match (0.0 to 1.0).
   - 0.0 = Not performed at all.
   - 0.5 = Partially performed or performed incorrectly.
   - 1.0 = Clearly and correctly performed.
2. **CRITICAL**: For Key Actions involving specific operations (e.g., "backup", "modify", "restart"), you must find EXPLICIT EVIDENCE in the execution steps that these actions were actually performed. Checking/reading is NOT the same as backing up/modifying.
3. Provide a brief explanation (in Chinese) for your evaluation of each item.

Special Scoring Rules for Control Flow Types:
- **可选 (optional)**: If this action was NOT performed, give a score of 0.0 but note in your explanation that it is optional and does not affect the overall score. If it WAS performed, score normally.
- **条件分支 (conditional)**: This action belongs to a conditional branch. Only evaluate whether this specific branch's action was performed. If the actual scenario did not require this branch (e.g., the fault type was different), a score of 0.0 is acceptable and should be explained as "此分支未触发" (this branch was not triggered).
- **循环 (loop)**: This action is part of a loop. Evaluate whether the loop body was executed, and if the number of executions falls within the expected range. If executed the expected number of times, score 1.0. If executed but fewer times than expected, score 0.5. If not executed at all, score 0.0.

Respond ONLY with a JSON object in the following format:
{
  "evaluations": [
    { "id": "KA-0", "match_score": 1.0, "explanation": "..." }
    ...
  ]
}
`;
  }

  return `
You are an objective and strict judge. Your task is to evaluate a "User Answer" against a set of weighted criteria for a given "User Query".

${skillSection}User Query: ${userQuery}
User Answer: ${actualAnswer}

Evaluation Criteria (Score strictly based on these weighted items):
1. Root Causes (Must identify these issues):
${rcList.map(rc => `   - [ID: ${rc.id}] [Weight: ${rc.weight}] ${rc.content}`).join('\n') || '   (None)'}

2. Key Actions:
${kaList.map(ka => formatKa(ka)).join('\n') || '   (None)'}

Evaluation Steps:
1. For each item listed above (marked with [ID: ...]), determine the degree of match (0.0 to 1.0).
   - 0.0 = Not mentioned or completely wrong.
   - 0.5 = Partially mentioned or vague.
   - 1.0 = Clearly and correctly addressed.
   **CRITICAL**: For Key Actions involving specific operations (e.g., "backup", "modify", "restart"), you must find EXPLICT EVIDENCE in the User Answer that these actions were performed (checking/reading is NOT the same as backing up).
2. Provide a brief explanation (in Chinese) for your evaluation of each item.
3. If a Reference Skill Definition is provided, consider whether the answer aligns with the skill's capabilities and instructions, but primarily score based on the specific Root Causes and Key Actions listed above.

Special Scoring Rules for Control Flow Types:
- **可选 (optional)**: If this action was NOT performed, give a score of 0.0 but note in your explanation that it is optional and does not affect the overall score. If it WAS performed, score normally.
- **条件分支 (conditional)**: This action belongs to a conditional branch. Only evaluate whether this specific branch's action was performed. If the actual scenario did not require this branch (e.g., the fault type was different), a score of 0.0 is acceptable and should be explained as "此分支未触发" (this branch was not triggered).
- **循环 (loop)**: This action is part of a loop. Evaluate whether the loop body was executed, and if the number of executions falls within the expected range. If executed the expected number of times, score 1.0. If executed but fewer times than expected, score 0.5. If not executed at all, score 0.0.

Respond ONLY with a JSON object in the following format:
{
  "evaluations": [
    { "id": "RC-0", "match_score": 0.5, "explanation": "此处用中文简要解释评分理由..." },
    { "id": "KA-0", "match_score": 1.0, "explanation": "..." }
    ...
  ]
}
`;
}
