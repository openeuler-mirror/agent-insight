import { readUserAgentDatasets } from '@/server/agent_datasets_storage';
import { datasetSchema } from './domain';
export async function existingDatasets(user: string) {
  return (await readUserAgentDatasets(user)).filter(d => d.datasetKind !== 'reliability').map(d => ({
    id: d.id,
    name: d.name
  }));
}
export async function importDataset(user: string, id: string) {
  const dataset = (await readUserAgentDatasets(user)).find(d => d.id === id);
  if (!dataset) throw new Error('评测集不存在或无权访问');
  if (dataset.datasetKind === 'reliability') throw new Error('故障注入评测集请使用原可靠性实验');
  return datasetSchema.parse({
    cases: dataset.cases.map(c => ({
      id: c.id,
      name: c.input.slice(0, 80) || c.id,
      tags: c.tags,
      note: c.evaluationFocus,
      turns: Array.isArray(c.values?.turns) ? c.values.turns : [{
        input: c.input,
        expectedOutput: c.expectedOutput,
        expectation: {}
      }]
    }))
  });
}
