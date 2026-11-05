import copy
import json
import pathlib
import subprocess
import sys

scripts = pathlib.Path('.agent-debug-diagnosis/scripts')
data = pathlib.Path('.agent-insight')

def run(name, *args):
    subprocess.run([sys.executable, str(scripts / name), *map(str, args)], check=True)

run('agentdebug_static.py', '--input', data / 'agent-debug-input.json', '--output', data / 'agent-debug-static.json')
run('agentdebug_inspect.py', 'summary', '--input', data / 'agent-debug-input.json', '--static', data / 'agent-debug-static.json')
core = json.loads((data / 'agent-debug-static.json').read_text())
core.update(humanSummary='Mock 模型响应：保留实际静态分析及专项诊断结果，仅验证流程与数据契约。', findings=[], rootCause=None)
(data / 'agent-debug-core.json').write_text(json.dumps(core, ensure_ascii=False))
run('detector_runner.py', 'run-all', '--mode', 'one_click', '--input', data / 'agent-debug-input.json', '--output', data / 'agent-debug-detectors.json')
final = copy.deepcopy(core)
final['detectorFindings'] = json.loads((data / 'agent-debug-detectors.json').read_text()).get('findings', [])
(data / 'agent-debug-final.json').write_text(json.dumps(final, ensure_ascii=False))
run('agentdebug_validate.py', '--input', data / 'agent-debug-final.json', '--static', data / 'agent-debug-static.json', '--core', data / 'agent-debug-core.json', '--detectors', data / 'agent-debug-detectors.json')
print('E2E-MOCK-DIAGNOSIS-VALIDATED')
