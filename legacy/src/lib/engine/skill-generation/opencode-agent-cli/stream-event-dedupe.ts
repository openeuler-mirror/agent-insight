/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export class MirroredDeltaGuard {
  private readonly pending = new Map<string, string[]>();

  remember(key: string, delta: string) {
    if (!key || !delta) return;
    const queue = this.pending.get(key) ?? [];
    queue.push(delta);
    if (queue.length > 128) queue.shift();
    this.pending.set(key, queue);
  }

  consume(key: string, delta: string) {
    if (!key || !delta) return false;
    const queue = this.pending.get(key);
    if (!queue?.length) return false;
    const index = queue.indexOf(delta);
    if (index === -1) return false;
    queue.splice(index, 1);
    if (queue.length === 0) this.pending.delete(key);
    return true;
  }
}
