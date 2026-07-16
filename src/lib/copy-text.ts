/**
 * 复制文本到剪贴板,带 fallback。所有复制入口统一走这里。
 *
 * navigator.clipboard.writeText 会在以下场景 throw:
 *   - document 没 focus (用户 focus 在 DevTools / 别的窗口) → NotAllowedError
 *   - 非 secure context (HTTP, 非 localhost) → 接口 undefined(内网 http 部署的常态!)
 *   - 某些 iframe 嵌套场景
 *
 * fallback: 隐藏 textarea + document.execCommand('copy') —— deprecated 但
 * 兼容性极好 (所有浏览器都支持,不依赖 secure context / focus 状态)。
 */
export async function copyText(text: string): Promise<void> {
  // 先试 modern clipboard API
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      // 常见 root cause: 'Document is not focused' (DevTools 抢焦点 / 弹窗丢焦点 等)
      console.warn('[copyText] clipboard.writeText failed, fallback to execCommand:',
        (e as Error)?.message || e);
    }
  }
  // Fallback: 隐藏 textarea + execCommand
  if (typeof document === 'undefined') throw new Error('no document available');
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  ta.select();
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand("copy") returned false');
  } finally {
    document.body.removeChild(ta);
  }
}
