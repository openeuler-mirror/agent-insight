export interface TaskArtifactExtraction {
  input: string;
  output: string;
  trace: unknown[];
  warnings: string[];
}

export async function extractTaskArtifacts(args: {
  rawInput: string;
  fallbackOutput: string;
  interactions: unknown[];
}): Promise<TaskArtifactExtraction> {
  const input = args.rawInput;
  const output = args.fallbackOutput;
  const warnings: string[] = [];
  if (!input.trim()) warnings.push('原始用户输入为空，请在保存前补充。');
  if (!output.trim()) warnings.push('最终输出为空，请在保存前补充。');

  return {
    input,
    output,
    trace: args.interactions,
    warnings,
  };
}
