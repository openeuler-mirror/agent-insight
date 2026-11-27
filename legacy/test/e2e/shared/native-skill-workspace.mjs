import {executionModel} from './model-config.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { writePrivate } from './runtime.mjs';

const require=createRequire(import.meta.url);
const {prepareSkillExperimentWorkspace}=require('../../../scripts/skill-experiment-workspace.cjs');
const [inputFile,outputFile]=process.argv.slice(2);
if(!inputFile || !outputFile)throw new Error('Private request and manifest paths are required');
const input=JSON.parse(fs.readFileSync(inputFile));
const workspace=prepareSkillExperimentWorkspace(input.executable,{
  platform:'opencode',agent:'build',model:executionModel(),
  skillExecution:{version:1,skill:input.skill},
},undefined,input.clientId);
writePrivate(outputFile,{cwd:workspace.cwd,env:workspace.env});
