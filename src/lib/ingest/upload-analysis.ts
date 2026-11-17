import {saveExecutionRecord,extractInvokedSkillsFromSessionInteractions} from '@/lib/storage/data-service';
import {analyzeDynamicOnly} from '@/lib/engine/observability/flow-parser';
import {analyzeFailures,analyzeSession,type InvokedSkill} from '@/lib/engine/evaluation/judge';
import {isEvaluatorTraceRecord} from '@/lib/evaluator-agent';
import {db} from '@/lib/storage/prisma';
import {assertActive,finish,startOrReplace} from '@/lib/evaluation-task-manager';
export interface UploadAnalysisSource {check():Promise<void>;findSkill(name:string):Promise<any>;save(data:any):Promise<unknown>;dynamic(taskId:string):Promise<any>;complete(taskId:string):Promise<unknown>;}
export async function processUploadAsync(data: any, username: any, normalized: any, interactions: any, source?:UploadAnalysisSource) {
    const taskId = String(data.task_id || '');
    if (!username) {
        console.log(`[Upload-Async] No username, skipping evaluation for task_id=${taskId}`);
        return;
    }

    const { runId } = startOrReplace(username, taskId, "upload");
    console.log(`[Upload-Async] Starting background analysis for ${taskId} with runId=${runId}`);

    const analysis = await analyzeSession(normalized, username);
    assertActive(username, taskId, runId);await source?.check();
    
    if (!data.query && analysis.query) data.query = analysis.query;
    if (!data.final_result && analysis.final_result) data.final_result = analysis.final_result;
    
    const skillsWithVersions: InvokedSkill[] = extractInvokedSkillsFromSessionInteractions(data.framework, normalized) ?? [];
    assertActive(username, taskId, runId);await source?.check();
    
    const skills = skillsWithVersions.map(s => s.name);
    
    if (skills.length > 0) {
        data.skills = skills;
        data.invokedSkills = skillsWithVersions;
        if (!data.skill) data.skill = skills[0];
        console.log(`[Upload-Async] Extracted skills: ${JSON.stringify(skillsWithVersions)}`);
        console.log(`[Upload-Async] Current data.skill_version: ${data.skill_version}`);
        if (skillsWithVersions[0]?.version != null) {
            data.skill_version = skillsWithVersions[0].version;
            console.log(`[Upload-Async] Updated skill_version from tool call: ${data.skill_version}`);
        }
        console.log(`[Upload-Async] 🛠️ Extracted Skills: ${JSON.stringify(skillsWithVersions)} for task_id=${data.task_id}`);
    } else {
        data.skills = [];
        data.invokedSkills = [];
        console.log(`[Upload-Async] ⚠️ No skills extracted for task_id=${data.task_id}`);
    }

    if (data.query) {
        data.query = data.query.trim().replace(/^['"]+|['"]+$/g, '').trim();
    }
    if (data.skill) {
        data.skill = data.skill.trim().replace(/^['"]+|['"]+$/g, '').trim();
    }

    if (!data.query) {
        console.log(`[Upload-Async] Empty query after analysis, aborting task_id=${data.task_id}`);
        finish(username, taskId, runId);
        return;
    }

    let skillDef = undefined;
    const primarySkillName = data.skill;
    console.log(`[Upload-Async] Primary skill name: ${primarySkillName}, current skill_version: ${data.skill_version}`);
    if (primarySkillName) {
          const skillRecord = await (source?source.findSkill(primarySkillName):db.findSkill(primarySkillName, username || null));
          assertActive(username, taskId, runId);await source?.check();
          console.log(`[Upload-Async] Skill record found: ${skillRecord ? skillRecord.name : 'null'}, activeVersion: ${skillRecord?.activeVersion}, versions: ${skillRecord?.versions?.map((v: any) => v.version).join(',')}`);
          if (skillRecord && skillRecord.versions && skillRecord.versions.length > 0) {
             const targetVersion = skillRecord.activeVersion || 0;
             const sv = skillRecord.versions.find((v: any) => v.version === targetVersion);
             if (sv && sv.content) {
                 skillDef = sv.content;
                 data.skill_version = sv.version;
                 console.log(`[Upload-Async] Using active version ${sv.version} for skill ${primarySkillName}`);
             } else {
                 skillDef = skillRecord.versions[0].content;
                 data.skill_version = skillRecord.versions[0].version;
                 console.log(`[Upload-Async] Using fallback version ${skillRecord.versions[0].version} for skill ${primarySkillName}`);
             }
         }
    }

    data.skip_evaluation = true;
    data.force_judgment = false;
    await (source?source.save(data):saveExecutionRecord(data, { receivedAt: null }));
    assertActive(username, taskId, runId);await source?.check();

    try {
        const dynamicResult = await (source?source.dynamic(data.task_id):analyzeDynamicOnly(data.task_id, username));
        assertActive(username, taskId, runId);await source?.check();
        if (dynamicResult.success) {
            console.log(`[Upload-Async] Auto-parsed dynamic flow for ${data.task_id}`);
        } else {
            console.warn(`[Upload-Async] Auto-parse dynamic flow failed for ${data.task_id}: ${dynamicResult.error}`);
        }
    } catch (e) {
        console.warn(`[Upload-Async] Auto-parse dynamic flow error for ${data.task_id}:`, e);
    }

    assertActive(username, taskId, runId);await source?.check();
    const isEvaluatorTrace = isEvaluatorTraceRecord({
        agent: data.agent ?? data.agentName,
        agentName: data.agentName,
        agents: data.agents,
        query: data.query,
        final_result: data.final_result,
        label: data.label,
    });
    let failureAnalysis: { failures: any[]; skill_issues?: any[] };
    if (isEvaluatorTrace) {
        console.log(`[Upload-Async] Skipping analyzeFailures for evaluator trace ${taskId} (agent=${data.agentName || data.agent || 'unknown'}) — evaluator output describes evaluated case, not this session`);
        failureAnalysis = { failures: [], skill_issues: [] };
    } else {
        failureAnalysis = await analyzeFailures(
            interactions,
            primarySkillName,
            skillDef,
            data.answer_score,
            String(data.judgment_reason || ""),
            data.query,
            data.final_result,
            username
        );
    }
    assertActive(username, taskId, runId);await source?.check();
    data.failures = failureAnalysis.failures;
    data.skill_issues = failureAnalysis.skill_issues;

    assertActive(username, taskId, runId);await source?.check();
    data.skip_evaluation = false;
    data.skip_internal_judgment = true;
    await (source?source.save(data):saveExecutionRecord(data, { receivedAt: null }));
    const shouldMarkSessionEnded = data.framework !== 'opencode' || data.opencode_cli_completed === true;
    if (taskId && shouldMarkSessionEnded) {
        try {
            await (source?source.complete(taskId):db.updateSession(taskId, { endTime: new Date() }));
        } catch (e) {
            console.warn(`[Upload-Async] Failed to mark session ended for ${taskId}:`, e);
        }
    }
    
    finish(username, taskId, runId);
    console.log(`[Upload-Async] ✅ Completed async analysis: task_id=${data.task_id}, score=${data.answer_score}, failures=${(data.failures || []).length}`);

}
