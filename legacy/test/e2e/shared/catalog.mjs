export const cases = [
  { id: '001', directory: '001-setup', title: '账号登录/模型配置/客户端接入' },
  { id: '002', directory: '002-opencode-observation', title: 'OpenCode 执行与 Trace 采集展示' },
  { id: '003', directory: '003-skill-lifecycle', title: 'Skill 生成/数据集评测/优化发布' },
  { id: '004', directory: '004-trace-evaluation', title: '已有 Trace 评测/诊断/Skill 优化' },
  { id: '005', directory: '005-fault-recovery', title: '故障注入/检测拦截/恢复验证' },
];
export function caseDirectory(id) { const item=cases.find(item=>item.id===id); if(!item) throw new Error("Unknown case: "+id); return item.directory; }
