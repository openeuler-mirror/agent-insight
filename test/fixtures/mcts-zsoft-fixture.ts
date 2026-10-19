import fs from 'node:fs'
import path from 'node:path'

export function writeSyntheticZsoftPlugin(root: string, mainBody = 'pass') {
  const modules: Record<string, string> = {
    'res/mode.py': `
OFFICIALS = {}
ARTIFACT_READERS = {}
def register(registry, name):
    def decorate(fn):
        registry[name] = fn
        return fn
    return decorate
class ModeSpec:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
    def prompts(self):
        return {role: 'zsoft/prompts/prompt_' + role + '.txt' for role in ['solver_init','solver_step','author_init','author_step','submission_selector']}
    def official_fn(self): return OFFICIALS[self.official_eval]
class Registry:
    def register(self, spec): self.spec = spec
MODES = Registry()
`,
    'res/task_plugins/zsoft/plugin.py': `
from testcases_union.res.mode import MODES, ModeSpec, OFFICIALS, register
from .official import evaluate
def configure_cli(parser):
    parser.add_argument('--task-id')
    parser.add_argument('--tasks-dir', default=None)
    parser.add_argument('--list-tasks', action='store_true')
@register(OFFICIALS, 'zsoft_official')
def submit(node, task, output_root): return evaluate(node, task, output_root)
MODES.register(ModeSpec(id='zsoft', official_eval='zsoft_official', artifact_reader='poc_file', configure_cli=configure_cli))
`,
    'res/task_plugins/zsoft/bundle.py': 'def poc_filename_for(manifest): return "poc.py"\n',
    'res/task_plugins/zsoft/flow.py': 'def extract_poc(session, task): return bytes([0,255,13,10,128]), task.poc_sandbox_path\n',
    'res/task_plugins/zsoft/official.py': `
def evaluate(node, task, output_root): raise RuntimeError('native judge called')
def _local(task, poc): raise RuntimeError('native local judge called')
def _post(url, task_id, filename, content): raise RuntimeError('native remote judge called')
`,
    'res/task_plugins/zsoft/task.py': `
from . import bundle
class ZSoftTask:
    @property
    def poc_filename(self): return bundle.poc_filename_for(None)
    @property
    def poc_sandbox_path(self): return '/home/user/workspace/repo/' + self.poc_filename
    def issue_text(self): return '[README]\\nPublic preflight example: python3 /input/poc\\n\\nKeep every public paragraph.'
    def init_solver(self): return 'Run python3 /input/poc\\n\\nMandatory Python preflight.\\n\\n' + self.issue_text()
    def step_solver(self, prior=None): return 'Run python3 /input/poc'
    def init_author(self, *, reference_example_paths=None): return 'Write verify.py'
    def step_author(self, prior, *, node_id=''): return 'Update verify.py'
`,
    'res/task_plugins/zsoft/artifact.py': 'def poc_file(node, task, *, session=None): raise RuntimeError("text reader called")\n',
    'core/main.py': `
import argparse
from testcases_union.res.mode import MODES
from testcases_union.res.task_plugins.zsoft.task import ZSoftTask
def _setup_task(mode_id, task_options):
    global _task, _spec
    _task, _spec = ZSoftTask(), MODES.spec
def main():
    p = argparse.ArgumentParser()
    p.add_argument('--mode', required=True)
    p.add_argument('--runtime', choices=('pi', 'xiaoo'))
    p.add_argument('--output-dir')
${['--max-iters', '--branching', '--max-turns-init', '--max-turns-step', '--max-turns-author', '--max-turns-author-step', '--token-fuse-limit'].map(flag => `    p.add_argument('${flag}', type=int)`).join('\n')}
${mainBody.split('\n').map(line => '    ' + line).join('\n')}
`,
  }
  for (const role of ['solver_init', 'solver_step', 'author_init', 'author_step', 'submission_selector']) {
    modules[`res/task_plugins/zsoft/prompts/prompt_${role}.txt`] = 'Run python3 /input/poc.\n\nAlways do Python preflight.\n\nRespect the public README.'
  }
  for (const [file, content] of Object.entries(modules)) {
    const target = path.join(root, 'testcases_union', file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}
