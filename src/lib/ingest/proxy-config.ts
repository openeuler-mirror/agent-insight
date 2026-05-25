import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

export interface ProxyConfig {
  customFetch: typeof fetch | undefined;
  proxyUrl: string | undefined;
  rejectUnauthorized: boolean;
}

let cachedProxyConfig: ProxyConfig | null = null;

export function getProxyConfig(): ProxyConfig {
  if (cachedProxyConfig) {
    return cachedProxyConfig;
  }

  const proxyUrl = process.env.https_proxy || 
                   process.env.HTTPS_PROXY || 
                   process.env.http_proxy || 
                   process.env.HTTP_PROXY;

  const rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';
  let customFetch: typeof fetch | undefined = undefined;

  if (proxyUrl) {
    console.log('[ProxyConfig] HTTP proxy configured (URL hidden for privacy)');
    
    if (rejectUnauthorized === false) {
      console.log('[ProxyConfig] SSL certificate verification is disabled');
    }

    const proxyAgent = new ProxyAgent({
      uri: proxyUrl,
      connect: {
        rejectUnauthorized
      }
    });

    const fallbackAgent = new Agent({
      connect: { rejectUnauthorized }
    });

    const noProxy = process.env.no_proxy || process.env.NO_PROXY;
    const noProxyList = noProxy ? noProxy.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];

    customFetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      let skipProxy = false;

      if (noProxyList.length > 0) {
        try {
          const parsedUrl = new URL(urlStr);
          const host = parsedUrl.hostname.toLowerCase();
          skipProxy = noProxyList.some(pattern => {
            if (pattern === '*') return true;
            if (host === pattern) return true;
            if (pattern.startsWith('.') && host.endsWith(pattern)) return true;
            if (!pattern.startsWith('.') && (host === pattern || host.endsWith('.' + pattern))) return true;
            return false;
          });
        } catch (e) {
          // Fallback if URL parsing fails
        }
      }

      return undiciFetch(url as any, {
        ...init as any,
        dispatcher: skipProxy ? fallbackAgent : proxyAgent
      });
    }) as unknown as typeof fetch;
  } else if (rejectUnauthorized === false) {
    console.log('[ProxyConfig] No proxy, but SSL certificate verification is disabled');
    const agent = new Agent({
      connect: { rejectUnauthorized: false }
    });
    customFetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      return undiciFetch(url as any, {
        ...init as any,
        dispatcher: agent
      });
    }) as unknown as typeof fetch;
  }

  cachedProxyConfig = {
    customFetch,
    proxyUrl,
    rejectUnauthorized
  };

  return cachedProxyConfig;
}

export function resetProxyConfigCache() {
  cachedProxyConfig = null;
}
