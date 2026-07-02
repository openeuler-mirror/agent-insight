/**
 * 流式 SSE 事件 → 持久化 Block[] 镜像。
 *
 * 同时做两件事：
 *   1. 把每个事件按 SSE 格式 enqueue 到 ReadableStreamController（流给前端）
 *   2. 在内存里维护一份等价的 blocks 数组，供 stream 结束时 JSON.stringify 入库
 *
 * 这样 page.tsx 在用户切回历史会话时只需 JSON.parse `Message.blocks`，就能 1:1 还原
 * thinking / tool / download / question 这些块的 UI 状态。
 *
 * 同源代码：原本 module-private 在 src/app/api/skill-generator/chat/route.ts:17，本期为
 * skill-opt 的会话历史持久化做共享而提取出来。skill-opt 没有 download/question/
 * skill-card 等 skill-generator 专属块，但同源逻辑无副作用——这些 block 不出现就不进数组。
 *
 * 与前端 Block union 同步：见 src/components/chat/chat-blocks.tsx 的 ToolBlockData
 * / ThinkingBlockData。新增块种类要两边一起改。
 */
export function createBlockMirror(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
) {
  const blocks: any[] = [];
  const send = (mode: string, payload: any) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ mode, payload })}\n\n`));

    if (mode === 'text') {
      const tail = blocks[blocks.length - 1];
      if (tail && tail.kind === 'text') tail.text += payload;
      else blocks.push({ kind: 'text', id: `text_${blocks.length}`, text: payload });
    } else if (mode === 'thinking') {
      const { id, delta, done } = payload || {};
      if (!id) return;
      const idx = blocks.findIndex((b: any) => b.kind === 'thinking' && b.id === id);
      if (idx === -1) blocks.push({ kind: 'thinking', id, text: delta || '', done: !!done });
      else {
        if (delta) blocks[idx].text += delta;
        if (done) blocks[idx].done = true;
      }
    } else if (mode === 'tool_call') {
      const { id, name, args, status } = payload || {};
      if (!id) return;
      // 重复 tool_call（bridge 在 delta phase 会重发 input 增量）→ 找到旧 block 更新 args，
      // 不要 push 重复条目。args 在 start 时可能空，delta/end 才完整。
      const idx = blocks.findIndex((b: any) => b.kind === 'tool' && b.id === id);
      if (idx === -1) {
        blocks.push({ kind: 'tool', id, name, args, status: status || 'running' });
      } else {
        if (args !== undefined) blocks[idx].args = args;
        if (name && !blocks[idx].name) blocks[idx].name = name;
        // 不回退状态：已经 ok/error 不被新来的 'running' 覆盖
        if (blocks[idx].status === 'running' && (status === 'ok' || status === 'error')) {
          blocks[idx].status = status;
        }
      }
    } else if (mode === 'tool_result') {
      const { id, status, summary, error, finalArgs } = payload || {};
      if (!id) return;
      const idx = blocks.findIndex((b: any) => b.kind === 'tool' && b.id === id);
      if (idx !== -1) {
        if (status) blocks[idx].status = status;
        if (summary) blocks[idx].summary = summary;
        if (error) blocks[idx].error = error;
        // skill-generator bridge 会在 end phase 单独发 finalArgs 兜底（防 args 在 delta 期间漏）
        if (finalArgs && typeof finalArgs === 'object') {
          blocks[idx].args = finalArgs;
        }
      }
    } else if (mode === 'download') {
      const { id, skillName, fileCount, sizeBytes } = payload || {};
      if (!id) return;
      blocks.push({ kind: 'download', id, skillName, fileCount, sizeBytes });
    } else if (mode === 'question') {
      const { id, question, choices } = payload || {};
      if (!id) return;
      blocks.push({ kind: 'question', id, question: question || '', choices, status: 'pending' });
    } else if (mode === 'question_answered') {
      const { id, status, answer } = payload || {};
      if (!id) return;
      const idx = blocks.findIndex((b: any) => b.kind === 'question' && b.id === id);
      if (idx !== -1) {
        if (status) blocks[idx].status = status;
        if (answer !== undefined) blocks[idx].answer = answer;
      }
    }
    // 'vfs_patch' / 'done' / 'error' 是运行时事件，不入持久化数组。
  };
  return { send, getBlocks: () => blocks };
}
