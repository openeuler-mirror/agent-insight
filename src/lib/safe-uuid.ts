/**
 * HTTP 环境兼容的 UUID v4 生成器。
 *
 * 为什么不直接用 `crypto.randomUUID()`：浏览器只在 **secure context**（HTTPS / localhost）
 * 暴露 `crypto.randomUUID`；通过 `http://<内网 IP>:port` 访问 dev/staging 时，
 * `crypto` 对象在但 `crypto.randomUUID` 是 `undefined`，前端调用直接 throw
 * `crypto.randomUUID is not a function`。
 *
 * 这里走两级回退：
 *   1. `crypto.randomUUID()` —— HTTPS / localhost / Node ≥ 19 直接用，效率最高。
 *   2. `crypto.getRandomValues()` —— **所有现代浏览器都暴露，不受 secure context 限制**，
 *      手工拼一个符合 RFC 4122 v4 的 UUID，密码学随机性等同 randomUUID。
 *   3. 极端兜底 `Date.now() + Math.random()` —— 理论上现代环境到不了这条；保留只为防御
 *      古老 polyfill 缺失场景，碰撞风险更高但至少不 throw。
 */
export function safeUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // RFC 4122 §4.4: version 4 + variant 10xx
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex: string[] = [];
    for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    );
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}`;
}
