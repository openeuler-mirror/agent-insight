import {compatibilityContext, type CompatibilityOptions} from './compat';
import {requestCore} from './server';

const MAX_MODELS = 10000;
const RESPONSE_BYTES = 2 * 1024 * 1024;

function invalid(status = 502): never {
  throw Object.assign(new Error(status === 413 ? 'Observed model facet exceeds budget' : 'Observed model facet unavailable'), {status});
}

export async function readCoreObservedModels(request: Request, options: CompatibilityOptions = {}): Promise<{username: string; models: string[]}> {
  const actor = await compatibilityContext(request, options);
  if (!actor.username?.trim()) throw Object.assign(new Error('Verified model identity required'), {status: 403});
  const query = new URLSearchParams({workspace_id: actor.workspace, facet: 'values', column: 'model'});
  const {data, status} = await requestCore('/v1/compat/observe/data?' + query, {
    token: actor.token, responseLimit: RESPONSE_BYTES, timeoutMs: 15000,
  }, options.fetcher || fetch);
  if (status !== 200 || Object.keys(data).length !== 1 || !Array.isArray(data.value)) invalid();
  if (data.value.length > MAX_MODELS) invalid(413);
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of data.value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).length !== 2 || typeof item.value !== 'string'
      || !Number.isSafeInteger(item.count) || item.count <= 0 || seen.has(item.value)) invalid();
    if (Buffer.byteLength(item.value, 'utf8') > 4096) invalid(413);
    seen.add(item.value);
    models.push(item.value);
  }
  return {username: actor.username, models};
}
