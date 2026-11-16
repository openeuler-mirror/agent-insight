import copy


def overlay_record(record,selected):
    record=dict(record)
    reset=selected.get('answer_reset')
    def clear_answer():
        record.update(answer_score=None,is_answer_correct=False,judgment_reason='结果评估中...')
        projection=reset.get('query_projection') if reset else None
        if isinstance(projection,dict):
            for key in ('is_skill_correct','skill_trigger_rate','routing_evaluation','outcome_evaluation'):
                if key in projection:record[key]=copy.deepcopy(projection[key])
    if selected['run_id'] is not None or reset:record['is_evaluating']=selected['is_evaluating']
    if selected['outcome'] is None:
        if reset:clear_answer()
        return record
    value=selected['outcome']['value']
    for key in ('answer_score','is_answer_correct','judgment_reason','failures','skill_issues'):record[key]=copy.deepcopy(value[key])
    record['has_failures']=bool(value['failures'])
    projection=value.get('record_projection')
    if isinstance(projection,dict):
        for key in ('skills','invokedSkills','skill','skill_version','is_skill_correct','skill_trigger_rate','routing_evaluation','outcome_evaluation'):
            if reset and key in ('is_skill_correct','skill_trigger_rate','routing_evaluation','outcome_evaluation'):continue
            if key in projection:record[key]=copy.deepcopy(projection[key])
        if 'invokedSkills' in projection:record['invoked_skills']=copy.deepcopy(projection['invokedSkills'])
        if 'skill' in projection:
            root={'name':projection['skill'],'version':projection.get('skill_version')} if projection['skill'] else None
            record['rootSkill']=root;record['root_skill']=copy.deepcopy(root)
    if reset:clear_answer()
    return record
