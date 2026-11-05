import fs from 'node:fs';
export function traceBaselineFiles(name) {
  return {
    'SKILL.md': `---\nname: ${name}\ndescription: Read-only analysis of root SSH authentication failures in a user-provided offline messages file.\n---\n\n# root SSH 失败分析\n\n只分析用户给定的离线日志，不扫描其他文件，不联网，不修改日志。输入契约：文件可读且含至少一条 root SSH 认证失败；脚本非零退出只表示输入不符合契约，没有可供分析的结果。\n\n## Step 1：运行统计脚本\n使用 python3 <本 Skill 目录>/scripts/analyze_logs.py <用户日志的绝对路径>，读取实际 JSON 结果；只有退出码 0 的 JSON 是有效分析结果。\n\n## Step 2：回答并引用证据\n根据脚本输出，用中文报告 root_ssh_failures、top_source、top_source_failures 三项事实，并从 evidence 原样引用至少一条日志。保留对实际日志的解释。将三项事实和引文逐项与脚本 JSON 比对，并在回答中逐项列出三个字段的脚本值和报告值，以及所引日志原文；不能只说已核对。本版本输出中文总结和日志证据。\n`,
    'scripts/analyze_logs.py':fs.readFileSync(new URL('./fixtures/trace_root_ssh.py',import.meta.url),'utf8'),
  };
}
