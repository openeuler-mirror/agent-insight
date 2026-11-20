import assert from 'node:assert/strict';

export function controlRecordSnapshot(owner: string, tables: Record<string, Array<Record<string, unknown>>>) {
  const snapshot = JSON.parse(JSON.stringify(tables)) as typeof tables;
  return (body: Record<string, any>) => {
    if (body.action === 'scope') return Response.json({value: {authorized: true}});
    assert.equal(body.action, 'records_read', 'Snapshot fixtures cannot accept control mutations');
    assert.ok(Object.hasOwn(snapshot, body.kind), 'Missing control fixture kind: ' + body.kind);
    const rows = snapshot[body.kind].filter(row =>
      (!body.ids || body.ids.includes(row.id)) &&
      Object.entries(body.metadata || {}).every(([field, value]) => Array.isArray(value) ? value.includes(row[field]) : row[field] === value),
    );
    return Response.json({value: {scope_revision: '1', rows: rows.map(row => ({
      record_id: row.id, revision: '1', owner_principal_id: owner, data: Object.fromEntries(Object.entries(row).filter(([field]) => body.body || body.fields?.includes(field) || !(field.endsWith('Json') || ['content','files','output','blocks','rawOutput','externalAccount','apiKey','tokenHash','credentialHash'].includes(field)))),
    }))}});
  };
}
