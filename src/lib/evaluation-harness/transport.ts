export async function readJsonResponse(response: Response, maxBytes = 1000000): Promise<unknown> {
  if (!response.body) throw new Error('服务返回为空');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    text = '';
  try {
    while (true) {
      const {
        done,
        value
      } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('服务返回超过大小限制');
      }
      text += decoder.decode(value, {
        stream: true
      });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
