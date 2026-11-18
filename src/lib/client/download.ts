import { apiFetch } from './api';

function responseFilename(disposition: string | null, fallback: string): string {
  const encoded = /\bfilename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition || '');
  const utf8 = /^UTF-8'[^']*'(.*)$/i.exec((encoded?.[1] ?? encoded?.[2] ?? '').trim());
  if (utf8) {
    try {
      const name = decodeURIComponent(utf8[1]);
      if (name) return name;
    } catch {}
  }
  const plain = /\bfilename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i.exec(disposition || '');
  return plain?.[1]?.replace(/\\(.)/g, '$1') || plain?.[2]?.trim() || fallback;
}

export async function downloadApiFile(url: string, fallbackFilename: string): Promise<void> {
  const response = await apiFetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = responseFilename(response.headers.get('content-disposition'), fallbackFilename);
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
