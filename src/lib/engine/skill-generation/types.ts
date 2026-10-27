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

import type { BaseMessage } from "@langchain/core/messages";

export interface SkillSpec {
  name: string;
  intent: string;
  triggerScenarios: string[];
  expectedOutput: string;
  testCases: Array<{
    prompt: string;
    expectations: string[];
  }>;
}

export interface EvalReport {
  skillName: string;
  iteration: number;
  timestamp: string;
  
  structure: {
    passed: boolean;
    issues: Array<{ severity: 'error' | 'warning'; message: string; path?: string }>;
  };
  
  trigger: {
    passRate: number;
    falsePositiveRate: number;
    falseNegativeRate: number;
    failedQueries: Array<{ query: string; expected: boolean; actual: boolean }>;
  };
  
  e2e: {
    passRate: number;
    perEval: Array<{
      evalId: number;
      prompt: string;
      passed: boolean;
      expectations: Array<{ text: string; passed: boolean; evidence: string }>;
      durationMs: number;
      tokens: number;
    }>;
  };
  
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low';
    target: 'frontmatter' | 'body' | 'scripts' | 'references' | 'evals';
    suggestion: string;
  }>;
  
  overall: {
    score: number;
    verdict: 'pass' | 'iterate' | 'fail';
  };
}

export interface IterationRecord {
  iteration: number;
  score: number;
  decision: 'iterate' | 'accept' | 'abort';
  reasons: string[];
  reportPath: string;
}
