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
