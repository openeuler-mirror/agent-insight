export function applicationFailureDiagnostics(log) {
  const unique = values => [...new Set(values)].sort();
  return {
    prismaCodes: unique(log.match(/\bP\d{4}\b/g) || []),
    errorTypes: unique(log.match(/\b(?:TypeError|RangeError|ReferenceError|SyntaxError|PrismaClientKnownRequestError|PrismaClientUnknownRequestError|PrismaClientValidationError)\b/g) || []),
    experimentDetailFailures: (log.match(/\[Experiment Detail Error\]/g) || []).length,
    transactionClosed: /Transaction already closed|transaction.*expired/i.test(log),
    databaseLocked: /database is locked|SQLITE_BUSY/i.test(log),
    connectionPoolTimeout: /connection pool|Timed out fetching a new connection/i.test(log),
    nullProperty: /Cannot read properties of (?:null|undefined) \(reading '([a-zA-Z_$][\w$]{0,60})'\)/.exec(log)?.[1] || null,
    stackLocations: unique([...log.matchAll(/^\s+at [^\n]*?(\.next\/server\/[\w/.-]+\.js:\d+:\d+)/gm)].map(match => match[1])).slice(0, 12),
  };
}
