const URL_PREFIX = process.env.NEXT_PUBLIC_URL_PREFIX || '';

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const fullUrl = URL_PREFIX + url;
  return fetch(fullUrl, options);
}

export function getApiUrl(url: string): string {
  return URL_PREFIX + url;
}
