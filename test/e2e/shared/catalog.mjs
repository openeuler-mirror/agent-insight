export const cases = [
  { id: '001', directory: '001-setup', title: '准备与配置' },
  { id: '002', directory: '002-opencode-observation', title: 'OpenCode 上报与观测' },
  { id: '003', directory: '003-skill-lifecycle', title: 'Skill 与数据集完整生命周期' },
  { id: '004', directory: '004-trace-evaluation', title: '已有 Trace 评测闭环' },
  { id: '005', directory: '005-fault-recovery', title: '故障检测恢复' },
];
export function caseDirectory(id) { const item=cases.find(item=>item.id===id); if(!item) throw new Error("Unknown case: "+id); return item.directory; }
