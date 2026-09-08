import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const targets = JSON.parse(await readFile(new URL('./targets.json', import.meta.url), 'utf8'));
const port = Number(process.env.PORT || 4319);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function skillContents(content) {
  return {prompt:content.prompt || '',skills:(content.skills || []).map(s=>({name:s.name,description:s.description || '',prompt:s.prompt || ''})),tools:(content.tools || []).map(t=>({name:t.name,description:t.description || '',parameters:t.parameters || {}}))};
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/targets') {
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(JSON.stringify(targets));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(200);
    res.end('Agent Insight evaluation Demo');
    return;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200000) {
      res.writeHead(413);
      res.end();
      return;
    }
  }
  try {
    let {
      input,
      history = [],
      targetVersion,
      targetId,
      agentId,
      skillOverrides,
      model
    } = JSON.parse(raw);
    const definition = targets.find(t => t.content.externalId === targetId && t.content.externalVersion === targetVersion)?.content;
    if (!definition) {
      res.writeHead(404);
      res.end(JSON.stringify({
        error: 'Unknown target version'
      }));
      return;
    }
    if (model && !['demo-basic','demo-reasoning'].includes(model)) {res.writeHead(400);res.end(JSON.stringify({error:'Demo only supports demo-basic and demo-reasoning'}));return;}
    let loadedSkillDefinition;
    const loadedSkills = [];
    if (skillOverrides !== undefined) {
      if (definition.type !== 'agent' || agentId !== targetId || !Array.isArray(skillOverrides) || skillOverrides.length !== 1) throw new Error('Invalid Agent Skill binding');
      for (const requested of skillOverrides) {
        const source = targets.find(t=>t.content.type === 'skill' && t.content.externalId === requested.skillId && (t.content.externalVersion || `v${t.version}`) === requested.skillVersion);
        if (!source) throw new Error('Unknown Skill version');
        const content = skillContents(source.content);
        const definitionHash = createHash('sha256').update(canonical(content)).digest('hex');
        if (canonical(content) !== canonical(requested.definition) || requested.definitionHash !== definitionHash) throw new Error('Skill content does not match its version');
        loadedSkillDefinition = source.content;
        loadedSkills.push({skillId:source.content.externalId,skillVersion:source.content.externalVersion || `v${source.version}`,definitionHash});
      }
    }
    const behavior = loadedSkillDefinition?.behavior || (model ? (model==='demo-reasoning'?'fixed':'baseline') : definition.behavior);
    const full = [...history.map(t => t.input), input].join(' ');
    let output,
      skill = 'loan_approval',
      state,
      tools = [];
    if (/额度|余额/.test(full)) {
      skill = 'balance_query';
      state = 'balance_returned';
      output = JSON.stringify({
        balance: 100000
      });
      tools = [{
        name: 'query_balance',
        arguments: {},
        result: {
          balance: 100000
        }
      }];
    } else if (/机票|天气/.test(full)) {
      skill = 'none';
      state = 'out_of_scope';
      output = '超出业务范围';
    } else {
      let amountMatch = full.match(/(\d+)\s*万/),
        amount = amountMatch ? Number(amountMatch[1]) * 10000 : null,
        risk = /高风险|风险.*高/.test(full) ? 'high' : /低风险|风险.*低/.test(full) ? 'low' : null;
      if (!amount) {
        state = 'waiting_amount';
        output = '请提供申请金额和风险等级';
      } else if (!risk) {
        state = 'waiting_risk';
        output = '请提供风险等级';
      } else if (behavior === 'fixed' && (risk === 'high' || amount > 500000)) {
        state = 'pending_review';
        output = '已提交人工复核';
        tools = [{
          name: 'request_human_review',
          arguments: {
            amount,
            risk
          },
          result: {
            state
          }
        }];
      } else {
        state = 'approved';
        output = '申请已审批通过';
        tools = [{
          name: 'approve_loan',
          arguments: {
            amount,
            risk
          },
          result: {
            state
          }
        }];
      }
    }
    if (targetId === 'loan_approval' && skill !== 'loan_approval') {
      state = 'out_of_scope';
      skill = 'none';
      tools = [];
      output = '该 Skill 不处理此类请求';
    }
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(JSON.stringify({
      output,
      ...(model ? {model} : {}),
      ...(loadedSkills.length ? {loadedSkills} : {}),
      skill,
      state,
      tools,
      systemPrompt: definition.prompt + (loadedSkillDefinition ? '\nSkill ' + loadedSkillDefinition.externalId + ': ' + loadedSkillDefinition.prompt : ''),
      targetVersion: definition.externalVersion
    }));
  } catch {
    res.writeHead(400);
    res.end('Invalid input');
  }
});
server.listen(port, '127.0.0.1', () => console.log('Demo Agent listening on ' + port));
