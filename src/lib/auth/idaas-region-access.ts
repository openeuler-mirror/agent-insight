import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

const IAM_TOKEN_TTL_MS = 10 * 60 * 60 * 1000;
const PERSON_TTL_MS = 2 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const PERSON_CACHE_MAX_SIZE = 5_000;

const EU_COUNTRIES = new Set([
  'austria',
  'belgium',
  'bulgaria',
  'croatia',
  'cyprus',
  'czechia',
  'denmark',
  'estonia',
  'finland',
  'france',
  'germany',
  'greece',
  'hungary',
  'ireland',
  'italy',
  'latvia',
  'lithuania',
  'luxembourg',
  'malta',
  'netherlands',
  'poland',
  'portugal',
  'romania',
  'slovakia',
  'slovenia',
  'spain',
  'sweden',
]);

export type IdaasRegionAccessDecision = 'allowed' | 'restricted';

export interface IdaasRegionAccessConfig {
  iamUrl: string;
  personUrl: string;
  iamProject: string;
  iamAccount: string;
  iamSecret: string;
  iamEnterprise: string;
  tlsVerify: boolean;
}

export class IdaasRegionAccessConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdaasRegionAccessConfigurationError';
  }
}

export class IdaasRegionAccessRequestError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'IdaasRegionAccessRequestError';
  }
}

type RegionFetchInit = RequestInit & { dispatcher?: Dispatcher };
type RegionFetcher = (input: string | URL, init?: RegionFetchInit) => Promise<Response>;
type PersonRecord = Record<string, unknown>;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface IdaasRegionAccessCheckerOptions {
  env?: Record<string, string | undefined>;
  fetcher?: RegionFetcher;
  now?: () => number;
  dispatcherFactory?: (tlsVerify: boolean) => Dispatcher;
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = String(env[name] || '').trim();
  if (!value) throw new IdaasRegionAccessConfigurationError('Missing ' + name);
  return value;
}

function validateHttpUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new IdaasRegionAccessConfigurationError('Invalid ' + name);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new IdaasRegionAccessConfigurationError('Invalid ' + name);
  }
  return parsed.toString();
}

function optionalBoolean(
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = String(env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new IdaasRegionAccessConfigurationError('Invalid ' + name);
}

export function getIdaasRegionAccessConfig(
  env: Record<string, string | undefined> = process.env,
): IdaasRegionAccessConfig | null {
  if (!optionalBoolean(env, 'IDAAS_REGION_ACCESS_ENABLED', false)) return null;

  return {
    iamUrl: validateHttpUrl(
      requiredEnv(env, 'IDAAS_REGION_ACCESS_IAM_URL'),
      'IDAAS_REGION_ACCESS_IAM_URL',
    ),
    personUrl: validateHttpUrl(
      requiredEnv(env, 'IDAAS_REGION_ACCESS_PERSON_URL'),
      'IDAAS_REGION_ACCESS_PERSON_URL',
    ),
    iamProject: requiredEnv(env, 'IDAAS_REGION_ACCESS_IAM_PROJECT'),
    iamAccount: requiredEnv(env, 'IDAAS_REGION_ACCESS_IAM_ACCOUNT'),
    iamSecret: requiredEnv(env, 'IDAAS_REGION_ACCESS_IAM_SECRET'),
    iamEnterprise: requiredEnv(env, 'IDAAS_REGION_ACCESS_IAM_ENTERPRISE'),
    tlsVerify: optionalBoolean(env, 'IDAAS_REGION_ACCESS_TLS_VERIFY', false),
  };
}

export function describeIdaasRegionAccessError(error: unknown): string {
  if (error instanceof IdaasRegionAccessRequestError) {
    return error.name + ': ' + error.code;
  }
  if (error instanceof IdaasRegionAccessConfigurationError) {
    return error.name + ': ' + error.message;
  }
  return error instanceof Error ? error.name : 'Unknown non-Error exception';
}

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string, now: number): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function putCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, expiresAt: number) {
  if (!cache.has(key) && cache.size >= PERSON_CACHE_MAX_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt });
}

function stringField(record: PersonRecord, name: string): string {
  const value = record[name];
  return typeof value === 'string' ? value.trim() : '';
}

function countryFromLocation(location: string): string {
  return location.split('\\')[0].trim().toLowerCase();
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    throw new IdaasRegionAccessRequestError('region_invalid_response');
  }
}

function firstPersonRecord(body: any): PersonRecord {
  const data = body?.data;
  const result = data && typeof data === 'object' ? data.result : null;
  if (!Array.isArray(result) || !result[0] || typeof result[0] !== 'object') {
    throw new IdaasRegionAccessRequestError('region_data_missing');
  }
  return result[0] as PersonRecord;
}

export function createIdaasRegionAccessChecker(
  options: IdaasRegionAccessCheckerOptions = {},
) {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher
    ?? (undiciFetch as unknown as RegionFetcher);
  const now = options.now ?? Date.now;
  const dispatcherFactory = options.dispatcherFactory
    ?? ((tlsVerify: boolean) => new Agent({
      connect: { rejectUnauthorized: tlsVerify },
    }));

  let dispatcher: Dispatcher | null = null;
  let tokenCache: CacheEntry<string> | null = null;
  let tokenInFlight: Promise<string> | null = null;
  const uuidCache = new Map<string, CacheEntry<PersonRecord>>();
  const managerCache = new Map<string, CacheEntry<PersonRecord>>();
  const uuidInFlight = new Map<string, Promise<PersonRecord>>();
  const managerInFlight = new Map<string, Promise<PersonRecord>>();

  const getDispatcher = (config: IdaasRegionAccessConfig): Dispatcher => {
    if (!dispatcher) dispatcher = dispatcherFactory(config.tlsVerify);
    return dispatcher;
  };

  const getIamToken = async (
    config: IdaasRegionAccessConfig,
    forceRefresh = false,
  ): Promise<string> => {
    const currentTime = now();
    if (forceRefresh) tokenCache = null;
    if (tokenCache && tokenCache.expiresAt > currentTime) return tokenCache.value;
    if (tokenInFlight) return tokenInFlight;

    tokenInFlight = (async () => {
      let response: Response;
      try {
        response = await fetcher(config.iamUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            data: {
              type: 'JWT-Token',
              attributes: {
                project: config.iamProject,
                account: config.iamAccount,
                secret: config.iamSecret,
                method: 'CREATE',
                enterprise: config.iamEnterprise,
              },
            },
          }),
          cache: 'no-store',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          dispatcher: getDispatcher(config),
        });
      } catch {
        throw new IdaasRegionAccessRequestError('region_token_request_failed');
      }

      if (!response.ok) {
        throw new IdaasRegionAccessRequestError('region_token_request_failed');
      }

      const body = await readJson(response);
      const accessToken = body?.access_token;
      if (typeof accessToken !== 'string' || !accessToken) {
        throw new IdaasRegionAccessRequestError('region_token_missing');
      }

      tokenCache = {
        value: accessToken,
        expiresAt: now() + IAM_TOKEN_TTL_MS,
      };
      return accessToken;
    })();

    try {
      return await tokenInFlight;
    } finally {
      tokenInFlight = null;
    }
  };

  const fetchPersonRecord = async (
    config: IdaasRegionAccessConfig,
    requestBody: Record<string, string[]>,
  ): Promise<PersonRecord> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await getIamToken(config, attempt === 1);
      let response: Response;
      try {
        response = await fetcher(config.personUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          cache: 'no-store',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          dispatcher: getDispatcher(config),
        });
      } catch {
        throw new IdaasRegionAccessRequestError('region_person_request_failed');
      }

      if (response.status === 401 && attempt === 0) {
        tokenCache = null;
        continue;
      }
      if (!response.ok) {
        throw new IdaasRegionAccessRequestError('region_person_request_failed');
      }
      return firstPersonRecord(await readJson(response));
    }

    throw new IdaasRegionAccessRequestError('region_person_request_failed');
  };

  const getPersonByUuid = async (
    config: IdaasRegionAccessConfig,
    uuid: string,
  ): Promise<PersonRecord> => {
    const cached = getCached(uuidCache, uuid, now());
    if (cached) return cached;
    const running = uuidInFlight.get(uuid);
    if (running) return running;

    const request = fetchPersonRecord(config, { uuids: [uuid] });
    uuidInFlight.set(uuid, request);
    try {
      const record = await request;
      putCached(uuidCache, uuid, record, now() + PERSON_TTL_MS);
      return record;
    } finally {
      uuidInFlight.delete(uuid);
    }
  };

  const getPersonByManager = async (
    config: IdaasRegionAccessConfig,
    managerNumber: string,
  ): Promise<PersonRecord> => {
    const cached = getCached(managerCache, managerNumber, now());
    if (cached) return cached;
    const running = managerInFlight.get(managerNumber);
    if (running) return running;

    const request = fetchPersonRecord(config, { employeeNumbers: [managerNumber] });
    managerInFlight.set(managerNumber, request);
    try {
      const record = await request;
      putCached(managerCache, managerNumber, record, now() + PERSON_TTL_MS);
      return record;
    } finally {
      managerInFlight.delete(managerNumber);
    }
  };

  const check = async (rawUuid: string): Promise<IdaasRegionAccessDecision> => {
    const config = getIdaasRegionAccessConfig(env);
    if (!config) return 'allowed';

    const uuid = String(rawUuid || '').trim();
    if (!uuid) throw new IdaasRegionAccessRequestError('region_data_missing');

    const person = await getPersonByUuid(config, uuid);
    const location = stringField(person, 'baseLocationNameEn');
    if (location) {
      const country = countryFromLocation(location);
      if (!country) throw new IdaasRegionAccessRequestError('region_data_missing');
      return EU_COUNTRIES.has(country) ? 'restricted' : 'allowed';
    }

    const organization = stringField(person, 'orgTreeNameEn');
    if (organization.toLowerCase().includes('european')) return 'restricted';

    const managerNumber = stringField(person, 'orgManagerNumber');
    if (!managerNumber) throw new IdaasRegionAccessRequestError('region_data_missing');

    const manager = await getPersonByManager(config, managerNumber);
    const managerLocation = stringField(manager, 'baseLocationNameEn');
    if (!managerLocation) throw new IdaasRegionAccessRequestError('region_data_missing');

    const managerCountry = countryFromLocation(managerLocation);
    if (!managerCountry) throw new IdaasRegionAccessRequestError('region_data_missing');
    return EU_COUNTRIES.has(managerCountry) ? 'restricted' : 'allowed';
  };

  return { check };
}

const defaultIdaasRegionAccessChecker = createIdaasRegionAccessChecker();

export function checkIdaasRegionAccess(uuid: string): Promise<IdaasRegionAccessDecision> {
  return defaultIdaasRegionAccessChecker.check(uuid);
}
