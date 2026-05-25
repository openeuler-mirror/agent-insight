import { readConfig, saveExecutionRecord, findBestMatchConfig } from '@/lib/storage/data-service';
import { analyzeFailures, extractSkillsFromClaudeSession, extractSkillsFromOpencodeSession, extractSkillsWithVersionsFromClaudeSession, extractSkillsWithVersionsFromOpencodeSession, InvokedSkill, judgeAnswer, normalizeInteractions } from '@/lib/engine/evaluation/judge';
import { isEvaluatorTraceRecord } from '@/lib/evaluator-agent';
import { NextResponse } from 'next/server';
import { db } from '@/lib/storage/prisma';
import { assertActive, finish, startOrReplace, EvaluationCancelledError } from '@/lib/evaluation-task-manager';

export async function POST(request: Request) {
  try {
    const data = await request.json();
    console.log(`[Rejudge] Received request for task: ${data.task_id || data.upload_id}`);

    const taskId = data.task_id || data.upload_id;
    if (!taskId) return NextResponse.json({ error: 'taskId required' }, { status: 400 });

    const actionUser = data.currentUser;
    if (!actionUser) {
        return NextResponse.json({ error: 'currentUser is required' }, { status: 400 });
    }

    const { runId } = startOrReplace(actionUser, taskId, "rejudge");
    console.log(`[Rejudge] Started evaluation with runId=${runId} for task=${taskId}`);

    const existingRecord = await db.findExecutionById(taskId);
    if (!existingRecord) {
        finish(actionUser, taskId, runId);
        return NextResponse.json({ error: 'Record not found' }, { status: 404 });
    }

    if (existingRecord.user && existingRecord.user !== actionUser) {
        finish(actionUser, taskId, runId);
        return NextResponse.json({ error: 'You do not have permission to rejudge this record' }, { status: 403 });
    }

    const session = await db.findSessionByTaskId(taskId);
    if (!session || !session.interactions) {
        finish(actionUser, taskId, runId);
        return NextResponse.json({ error: 'Session log not found. Cannot rejudge without interactions.' }, { status: 400 });
    }

    const rawInteractions = JSON.parse(session.interactions);
    const normalized = normalizeInteractions(rawInteractions);

    let invokedSkills: InvokedSkill[] = [];
    if (existingRecord.invokedSkills) {
        try {
            const parsed = JSON.parse(existingRecord.invokedSkills);
            if (Array.isArray(parsed)) {
                invokedSkills = parsed;
            } else {
                console.warn('[Rejudge] invokedSkills is not an array, resetting to empty array');
                invokedSkills = [];
            }
        } catch (e) {
            console.warn('[Rejudge] Failed to parse invokedSkills:', e);
            invokedSkills = [];
        }
    }
    
    if (invokedSkills.length === 0) {
        if (existingRecord.framework === 'opencode') {
            invokedSkills = extractSkillsWithVersionsFromOpencodeSession(normalized);
        } else if (existingRecord.framework === 'claudecode' || existingRecord.framework === 'claude') {
            invokedSkills = extractSkillsWithVersionsFromClaudeSession(normalized);
        }
    }
    
    const skills = invokedSkills.map(s => s.name);
    const skillName = skills[0] || (existingRecord.skill || '').trim();
    let skillVersion = invokedSkills[0]?.version ?? existingRecord.skillVersion ?? undefined;

    console.log(`[Rejudge] Extracted skills: ${JSON.stringify(invokedSkills)}, skillName: ${skillName || 'none'}, skillVersion: ${skillVersion}`);

    let skillDef = undefined;

    if (skillName) {
         console.log(`[Rejudge] Looking for skill: ${skillName} for user: ${actionUser || 'null'}`);
         try {
             const skillRecord = await db.findSkill(skillName, actionUser);
             assertActive(actionUser, taskId, runId);
             console.log(`[Rejudge] Skill record found: ${skillRecord ? 'yes' : 'no'}, versions: ${skillRecord?.versions?.length || 0}`);
             
             if (skillRecord && skillRecord.versions && skillRecord.versions.length > 0) {
                 skillDef = skillRecord.versions[0].content;
                 console.log(`[Rejudge] Skill definition found, length: ${skillDef.length}`);
                 if (skillVersion === undefined) {
                     skillVersion = skillRecord.versions[0].version;
                     console.log(`[Rejudge] Using skill version: ${skillVersion}`);
                 }
             } else {
                 console.warn(`[Rejudge] Skill record found but no versions available`);
             }
         } catch (e) {
             if (e instanceof EvaluationCancelledError) {
                 console.log(`[Rejudge] Evaluation cancelled during skill lookup: ${e.message}`);
                 return NextResponse.json({ 
                     success: false, 
                     cancelled: true, 
                     message: 'Evaluation cancelled' 
                 }, { status: 200 });
             }
             console.error('[Rejudge] Error fetching skill definition:', e);
         }
    } else {
         console.warn(`[Rejudge] No skillName found, skipping skill definition lookup`);
    }

    const criteria: any = { skill_definition: skillDef };
    const configs = await readConfig(actionUser);
    assertActive(actionUser, taskId, runId);
    const query = existingRecord.query || '';
    const cfg = findBestMatchConfig(configs, query, 'outcome');
    
    if (!cfg) {
        console.warn(`[Rejudge] No matching evaluation configuration found for query: ${query}`);
        finish(actionUser, taskId, runId);
        return NextResponse.json({ 
            error: 'No matching evaluation configuration found for this query. Please ensure a valid configuration exists before re-judging.' 
        }, { status: 400 });
    }

    if (cfg) {
         criteria.root_causes = cfg.root_causes;
         criteria.key_actions = cfg.key_actions;
         criteria.standard_answer_example = cfg.standard_answer;
    }

    let executionSteps: { name: string; description: string; type: string }[] | null = null;
    try {
        const matchRecord = await db.findExecutionMatch(existingRecord.taskId || existingRecord.uploadId || '');
        if (matchRecord?.extractedSteps) {
            executionSteps = typeof matchRecord.extractedSteps === 'string' 
                ? JSON.parse(matchRecord.extractedSteps) 
                : matchRecord.extractedSteps;
        }
    } catch (e) {
        console.warn('[Rejudge] Failed to load execution steps for KA evaluation:', e);
    }

    assertActive(actionUser, taskId, runId);
    const judgment = await judgeAnswer(query, criteria, existingRecord.finalResult || '', actionUser, executionSteps);
    assertActive(actionUser, taskId, runId);
    const score = typeof judgment?.score === 'number' ? judgment.score : 0;
    
    console.log(`[Rejudge] Judgment result - score: ${score}, is_correct: ${judgment?.is_correct}, reason length: ${judgment?.reason?.length || 0}`);
    console.log(`[Rejudge] Judgment reason preview: ${judgment?.reason?.substring(0, 200) || 'none'}...`);
    
    if (score === 0 && (judgment.reason?.includes('failed') || judgment.reason?.includes('disabled') || judgment.reason?.includes('禁用'))) {
          finish(actionUser, taskId, runId);
          return NextResponse.json({ 
              error: `Judgment failed: ${judgment.reason}` 
          }, { status: 500 });
    }
    
    console.log(`[Rejudge] Before analyzeFailures - skillName: ${skillName || 'none'}, skillDef: ${skillDef ? 'present' : 'absent'}, score: ${score}, judgmentReason: ${judgment.reason ? 'present' : 'absent'}`);
    
    assertActive(actionUser, taskId, runId);
    const isEvaluatorTrace = isEvaluatorTraceRecord({
        agent: existingRecord.agentName,
        agentName: existingRecord.agentName,
        query,
        final_result: existingRecord.finalResult || '',
        label: existingRecord.label,
    });
    let failureAnalysis: { failures: any[]; skill_issues?: any[] };
    if (isEvaluatorTrace) {
        console.log(`[Rejudge] Skipping analyzeFailures for evaluator trace ${taskId} (agent=${existingRecord.agentName || 'unknown'}) — evaluator output describes evaluated case, not this session`);
        failureAnalysis = { failures: [], skill_issues: [] };
    } else {
        failureAnalysis = await analyzeFailures(
            normalized,
            skillName,
            skillDef,
            score,
            judgment.reason || '',
            query,
            existingRecord.finalResult || '',
            actionUser
        );
    }
    assertActive(actionUser, taskId, runId);

    console.log(`[Rejudge] After analyzeFailures - failures: ${failureAnalysis.failures?.length || 0}, skill_issues: ${failureAnalysis.skill_issues?.length || 0}`);

    assertActive(actionUser, taskId, runId);
    const result = await saveExecutionRecord({
        task_id: taskId,
        skills: skills,
        invokedSkills: invokedSkills,
        skill: skillName,
        skill_version: skillVersion,
        answer_score: score,
        is_answer_correct: judgment.is_correct,
        judgment_reason: judgment.reason || 'Rejudged',
        failures: failureAnalysis.failures,
        skill_issues: failureAnalysis.skill_issues,
        skip_internal_judgment: true
    });

    finish(actionUser, taskId, runId);

    return NextResponse.json({ 
        success: true, 
        message: 'Rejudged and re-analyzed successfully',
        record: result.record
    }, { status: 200 });

  } catch (error: any) {
    if (error instanceof EvaluationCancelledError) {
        console.log(`[Rejudge] Evaluation cancelled: ${error.message}`);
        return NextResponse.json({ 
            success: false, 
            cancelled: true, 
            message: 'Evaluation cancelled' 
        }, { status: 200 });
    }
    console.error('Rejudge Error:', error);
    return NextResponse.json({ error: 'Failed to rejudge' }, { status: 500 });
  }
}
