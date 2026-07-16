import { extractTaskResultArtifact } from '@/lib/engine/evaluation/result-artifact-extractor';
import { extractRealUserInput } from '@/lib/engine/evaluation/semantic-dataset-match';

export interface TaskArtifactExtraction {
  input: string;
  output: string;
  trace: unknown[];
  warnings: string[];
  extraction: {
    input: { confidence: number; reason: string };
    output: { confidence: number; reason: string; sourceRefs: string[] };
  };
}

export async function extractTaskArtifacts(args: {
  user: string;
  rawInput: string;
  fallbackOutput: string;
  interactions: unknown[];
}): Promise<TaskArtifactExtraction> {
  const extractedInput = await extractRealUserInput(args.rawInput, args.user);
  const input = extractedInput.normalized_input.trim() || args.rawInput.trim();
  const extractedOutput = await extractTaskResultArtifact({
    userTask: input,
    interactions: args.interactions,
    fallbackOutput: args.fallbackOutput,
    user: args.user,
  });
  const output = String(extractedOutput.outputForEvaluation || args.fallbackOutput || '').trim();
  const warnings: string[] = [];
  if (!input) warnings.push('未提取到任务输入，请在保存前补充。');
  if (!output) warnings.push('未提取到任务输出，请在保存前补充。');

  return {
    input,
    output,
    trace: args.interactions,
    warnings,
    extraction: {
      input: { confidence: extractedInput.confidence, reason: extractedInput.reason },
      output: {
        confidence: extractedOutput.confidence,
        reason: extractedOutput.reason,
        sourceRefs: extractedOutput.sourceRefs,
      },
    },
  };
}
