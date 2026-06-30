import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPERATORS_BY_TYPE,
  operatorsForColumn,
  isOperatorAllowed,
  type FilterColumn,
} from '@/lib/filters/types';
import { resolveTraceColumn, TRACE_FILTER_COLUMNS } from '@/lib/filters/trace-columns';
import { buildPrismaWhere } from '@/lib/filters/to-prisma';

// ---- registry + operator validity ----

test('OPERATORS_BY_TYPE: each type exposes its operator set', () => {
  assert.deepEqual(OPERATORS_BY_TYPE.string, ['=', 'contains', 'does not contain', 'starts with', 'ends with']);
  assert.deepEqual(OPERATORS_BY_TYPE.number, ['=', '>', '<', '>=', '<=']);
  assert.deepEqual(OPERATORS_BY_TYPE.datetime, ['>', '<', '>=', '<=']);
  assert.deepEqual(OPERATORS_BY_TYPE.stringOptions, ['any of', 'none of']);
  assert.deepEqual(OPERATORS_BY_TYPE.arrayOptions, ['any of', 'none of', 'all of']);
  assert.deepEqual(OPERATORS_BY_TYPE.boolean, ['=']);
});

test('operatorsForColumn: nullable columns gain is null / is not null', () => {
  const nullable: FilterColumn = { column: 'x', type: 'number', label: 'x', nullable: true };
  const nonNull: FilterColumn = { column: 'y', type: 'number', label: 'y' };
  assert.ok(operatorsForColumn(nullable).includes('is null'));
  assert.ok(operatorsForColumn(nullable).includes('is not null'));
  assert.ok(!operatorsForColumn(nonNull).includes('is null'));
  assert.equal(isOperatorAllowed(nonNull, 'is null'), false);
  assert.equal(isOperatorAllowed(nullable, '>'), true);
});

test('registry: known columns resolve, unknown does not; agents maps to observedAgents field', () => {
  assert.equal(resolveTraceColumn('latency')?.type, 'number');
  assert.equal(resolveTraceColumn('nope'), undefined);
  assert.equal(resolveTraceColumn('agents')?.field, 'observedAgents');
  assert.equal(resolveTraceColumn('skill')?.source, 'executionSkill');
  assert.equal(resolveTraceColumn('status')?.source, 'computed');
});

// ---- string lowering ----

test('string: contains / =/ does not contain / starts / ends', () => {
  assert.deepEqual(buildPrismaWhere([{ column: 'query', operator: 'contains', value: 'foo' }]).where, {
    AND: [{ query: { contains: 'foo' } }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'query', operator: '=', value: 'foo' }]).where, {
    AND: [{ query: 'foo' }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'query', operator: 'does not contain', value: 'foo' }]).where, {
    AND: [{ NOT: { query: { contains: 'foo' } } }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'agentName', operator: 'starts with', value: 'Ku' }]).where, {
    AND: [{ agentName: { startsWith: 'Ku' } }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'agentName', operator: 'ends with', value: 'or' }]).where, {
    AND: [{ agentName: { endsWith: 'or' } }],
  });
});

// ---- number / datetime range ----

test('number: comparison operators map to gt/lt/gte/lte/equals; coerces string', () => {
  assert.deepEqual(buildPrismaWhere([{ column: 'tokens', operator: '>=', value: 100 }]).where, {
    AND: [{ tokens: { gte: 100 } }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'cost', operator: '<', value: '0.5' }]).where, {
    AND: [{ cost: { lt: 0.5 } }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'latency', operator: '=', value: 200 }]).where, {
    AND: [{ latency: { equals: 200 } }],
  });
});

test('number: non-numeric value is an error, not a silent drop', () => {
  const r = buildPrismaWhere([{ column: 'tokens', operator: '>', value: 'abc' }]);
  assert.deepEqual(r.where, {});
  assert.equal(r.errors.length, 1);
});

test('datetime: range with ISO string parses to Date; "=" is rejected', () => {
  const r = buildPrismaWhere([{ column: 'timestamp', operator: '>=', value: '2026-06-01T00:00:00Z' }]);
  const frag = r.where.AND[0].timestamp;
  assert.ok(frag.gte instanceof Date);
  assert.equal(frag.gte.toISOString(), '2026-06-01T00:00:00.000Z');

  const bad = buildPrismaWhere([{ column: 'timestamp', operator: '=', value: '2026-06-01' }]);
  assert.deepEqual(bad.where, {});
  assert.equal(bad.errors.length, 1); // datetime validity table disallows '='
});

// ---- boolean ----

test('boolean: equals true/false, coerces "true"/"false"', () => {
  assert.deepEqual(buildPrismaWhere([{ column: 'isAnswerCorrect', operator: '=', value: true }]).where, {
    AND: [{ isAnswerCorrect: { equals: true } }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'isSubagent', operator: '=', value: 'false' }]).where, {
    AND: [{ isSubagent: { equals: false } }],
  });
});

// ---- stringOptions ----

test('stringOptions: any of -> in, none of -> notIn', () => {
  assert.deepEqual(buildPrismaWhere([{ column: 'framework', operator: 'any of', value: ['claude', 'opencode'] }]).where, {
    AND: [{ framework: { in: ['claude', 'opencode'] } }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'framework', operator: 'none of', value: ['hermes'] }]).where, {
    AND: [{ framework: { notIn: ['hermes'] } }],
  });
});

// ---- arrayOptions via observedAgents (JSON substring degrade) ----

test('arrayOptions(observedAgents): any of/all of/none of degrade to JSON-member contains', () => {
  assert.deepEqual(buildPrismaWhere([{ column: 'agents', operator: 'any of', value: ['Kuafu', 'General'] }]).where, {
    AND: [{ OR: [{ observedAgents: { contains: '"Kuafu"' } }, { observedAgents: { contains: '"General"' } }] }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'agents', operator: 'all of', value: ['a', 'b'] }]).where, {
    AND: [{ AND: [{ observedAgents: { contains: '"a"' } }, { observedAgents: { contains: '"b"' } }] }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'agents', operator: 'none of', value: ['x'] }]).where, {
    AND: [{ NOT: { OR: [{ observedAgents: { contains: '"x"' } }] } }],
  });
});

// ---- null operators on nullable columns ----

test('is null / is not null on nullable column', () => {
  assert.deepEqual(buildPrismaWhere([{ column: 'cost', operator: 'is null' }]).where, {
    AND: [{ cost: null }],
  });
  assert.deepEqual(buildPrismaWhere([{ column: 'cost', operator: 'is not null' }]).where, {
    AND: [{ cost: { not: null } }],
  });
});

// ---- deferred sources ----

test('executionSkill + computed columns are deferred, not lowered', () => {
  const r = buildPrismaWhere([
    { column: 'skill', operator: 'any of', value: ['git-commit'] },
    { column: 'status', operator: 'any of', value: ['failed'] },
    { column: 'ownership', operator: 'any of', value: ['user'] },
  ]);
  assert.deepEqual(r.where, {});
  assert.equal(r.deferred.length, 3);
  assert.equal(r.errors.length, 0);
});

// ---- validation errors ----

test('unknown column and disallowed operator become errors', () => {
  const r = buildPrismaWhere([
    { column: 'ghost', operator: '=', value: 'x' },
    { column: 'tokens', operator: 'contains', value: 'x' }, // number has no contains
    { column: 'query', operator: '>', value: 'x' }, // string has no >
  ]);
  assert.deepEqual(r.where, {});
  assert.equal(r.errors.length, 3);
});

// ---- AND composition + empty ----

test('multiple valid clauses AND-compose; empty input -> {}', () => {
  const r = buildPrismaWhere([
    { column: 'query', operator: 'contains', value: 'refund' },
    { column: 'latency', operator: '>', value: 2000 },
    { column: 'framework', operator: 'any of', value: ['claude'] },
  ]);
  assert.deepEqual(r.where, {
    AND: [
      { query: { contains: 'refund' } },
      { latency: { gt: 2000 } },
      { framework: { in: ['claude'] } },
    ],
  });
  assert.deepEqual(buildPrismaWhere([]).where, {});
});

// ---- registry hygiene ----

test('every registry column has a label and a valid type', () => {
  for (const c of TRACE_FILTER_COLUMNS) {
    assert.ok(c.label, `column ${c.column} missing label`);
    assert.ok(OPERATORS_BY_TYPE[c.type], `column ${c.column} has unknown type ${c.type}`);
  }
});
