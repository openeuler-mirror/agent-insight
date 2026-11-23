import copy
import json
import math

from .trace_evidence import EvidenceUnavailable


FIELDS=frozenset('skill skillVersion isSubagent skills invokedSkills executionSkills answerScore skillScore judgmentReason failures skillIssues isSkillCorrect isAnswerCorrect skillTriggerRate expectedSkillVersion cacheReadInputTokens cacheCreationInputTokens reasoningTokens maxSingleCallTokens'.split())


def select_execution(execution):
    result={key:copy.deepcopy(value) for key,value in execution.items() if key in FIELDS}
    for key in ('skills','invokedSkills','executionSkills','failures','skillIssues'):
        if key not in result or result[key] is None:continue
        value=result[key]
        if isinstance(value,str):
            try:value=json.loads(value)
            except ValueError:raise EvidenceUnavailable('Invalid captured execution metadata JSON') from None
            if value is None and key in ('failures','skillIssues'):
                result[key]='null';continue
        if value is None:
            result[key]=None;continue
        if not isinstance(value,list):raise EvidenceUnavailable('Invalid captured execution metadata collection')
        result[key]=value
    for key in ('skillVersion','expectedSkillVersion'):
        value=result.get(key)
        if value is not None and (type(value) is not int or value<0):raise EvidenceUnavailable('Invalid captured Skill version')
    for key in ('answerScore','skillScore','skillTriggerRate','cacheReadInputTokens','cacheCreationInputTokens','reasoningTokens','maxSingleCallTokens'):
        value=result.get(key)
        if value is not None and (type(value) not in (int,float) or not math.isfinite(value)):raise EvidenceUnavailable('Invalid captured execution metric')
    for key in ('isSubagent','isSkillCorrect','isAnswerCorrect'):
        if result.get(key) is not None and type(result[key]) is not bool:raise EvidenceUnavailable('Invalid captured execution flag')
    for key in ('skill','judgmentReason'):
        if result.get(key) is not None and not isinstance(result[key],str):raise EvidenceUnavailable('Invalid captured execution text')
    for row in result.get('executionSkills') or []:
        if not isinstance(row,dict) or not isinstance(row.get('skillName',row.get('name')),str):raise EvidenceUnavailable('Invalid captured ExecutionSkill')
        version=row.get('skillVersion',row.get('version'))
        if version is not None and (type(version) is not int or version<0):raise EvidenceUnavailable('Invalid captured ExecutionSkill version')
        if 'isPrimary' in row and type(row['isPrimary']) is not bool:raise EvidenceUnavailable('Invalid captured primary Skill')
    if 'executionSkills' in result:
        result['executionSkills']=[{key:row[key] for key in ('skillName','name','skillVersion','version','isPrimary') if key in row} for row in result['executionSkills']] if result['executionSkills'] is not None else None
    for row in result.get('invokedSkills') or []:
        if not isinstance(row,dict) or not isinstance(row.get('name'),str):raise EvidenceUnavailable('Invalid captured invoked Skill')
        version=row.get('version')
        if version is not None and (type(version) is not int or version<0):raise EvidenceUnavailable('Invalid captured invoked Skill version')
    if result.get('invokedSkills') is not None:result['invokedSkills']=[{'name':row['name'],'version':row.get('version')} for row in result['invokedSkills']]
    if any(not isinstance(name,str) for name in result.get('skills') or []):raise EvidenceUnavailable('Invalid captured Skill names')
    return result


def record_fields(execution):
    relations=execution.get('executionSkills')
    invoked=[{'name':row.get('skillName',row.get('name')),'version':row.get('skillVersion',row.get('version'))} for row in relations] if relations else None
    if invoked is None and execution.get('invokedSkills') is not None:invoked=copy.deepcopy(execution['invokedSkills'])
    skill=execution.get('skill');version=execution.get('skillVersion')
    root={'name':skill,'version':version} if skill and not execution.get('isSubagent') else None
    if root is None:
        primary=next((row for row in relations or [] if row.get('isPrimary')),None)
        if primary:root={'name':primary.get('skillName',primary.get('name')),'version':primary.get('skillVersion',primary.get('version'))}
    if root is None and skill:root={'name':skill,'version':version}
    result={'skill':skill,'skill_version':version,'root_skill':root,'rootSkill':copy.deepcopy(root),
            'is_skill_correct':execution.get('isSkillCorrect') if execution.get('isSkillCorrect') is not None else False,'skill_trigger_rate':execution.get('skillTriggerRate'),
            'expected_skill_version':execution.get('expectedSkillVersion'),
            'skill_issues':copy.deepcopy(execution.get('skillIssues') or []),
            '_execution_relations':copy.deepcopy(relations),'_source_skill':skill,'_source_skill_version':version}
    if invoked is not None:result.update(skills=[row['name'] for row in invoked],invokedSkills=invoked,invoked_skills=copy.deepcopy(invoked))
    elif execution.get('skills') is not None:result['skills']=copy.deepcopy(execution['skills'])
    for camel,snake in (('answerScore','answer_score'),('skillScore','skill_score'),('judgmentReason','judgment_reason'),('failures','failures'),('skillIssues','skill_issues'),('isAnswerCorrect','is_answer_correct'),('cacheReadInputTokens','cache_read_input_tokens'),('cacheCreationInputTokens','cache_creation_input_tokens'),('reasoningTokens','reasoning_tokens'),('maxSingleCallTokens','max_single_call_tokens')):
        if camel not in execution:continue
        if camel in ('failures','skillIssues') and execution[camel] is None:continue
        if camel=='judgmentReason' and not execution[camel]:continue
        value=execution[camel]
        result[snake]=json.loads(value) if camel in ('failures','skillIssues') and isinstance(value,str) else copy.deepcopy(value)
    if 'failures' in result:result['has_failures']=bool(result['failures'])
    return result
