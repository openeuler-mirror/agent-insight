/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

test('home environment types accept dotenv maps without requiring Next NODE_ENV', () => {
  const filename = path.resolve('test/agent-insight-home-type-fixture.ts')
  const source = `
    import 'next';
    import { config, type DotenvParseOutput } from 'dotenv';
    import { assertSupportedHomeEnv, getAgentInsightHome, resolveStartupDatabaseUrl } from '../scripts/agent-insight-home.cjs';
    const parsed: DotenvParseOutput = { AGENT_INSIGHT_HOME: '/tmp/test' };
    assertSupportedHomeEnv(config().parsed || {});
    assertSupportedHomeEnv(parsed);
    assertSupportedHomeEnv(process.env);
    assertSupportedHomeEnv({});
    getAgentInsightHome(parsed);
    getAgentInsightHome(process.env);
    getAgentInsightHome({});
    resolveStartupDatabaseUrl(parsed, process.env);
    resolveStartupDatabaseUrl({}, {});
    // @ts-expect-error Environment values must be strings or undefined.
    assertSupportedHomeEnv({ AGENT_INSIGHT_HOME: 123 });
  `
  const config = ts.readConfigFile('tsconfig.next.json', ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
  const options = { ...parsed.options, noEmit: true, incremental: false }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) =>
    name === filename ? ts.createSourceFile(name, source, version, true)
      : getSourceFile(name, version, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([filename, path.resolve('next.config.ts'), path.resolve('src/lib/env.ts')], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }))
})
