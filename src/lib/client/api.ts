const URL_PREFIX = process.env.NEXT_PUBLIC_URL_PREFIX || '';

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const fullUrl = URL_PREFIX + url;
  const headers = new Headers(options?.headers);
  if (typeof window !== 'undefined' && (url.startsWith('/api/agent-datasets') || url.startsWith('/api/experiments') || url.startsWith('/api/eval/trajectory') || url.startsWith('/api/debug/grayscale')) && !headers.has('x-witty-api-key')) {
    const key = localStorage.getItem('api_key');
    if (key) headers.set('x-witty-api-key', key);
  }
  return fetch(fullUrl, { ...options, headers });
}

export function getApiUrl(url: string): string {
  return URL_PREFIX + url;
}
