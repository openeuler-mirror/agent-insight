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

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isMissingEvaluationModelError } from '@/lib/evaluators/model-configuration-error';

export function EvaluationErrorNotice({ message, compact = false }: { message: string; compact?: boolean }) {
  if (!isMissingEvaluationModelError(message)) {
    return <p role="alert" className="whitespace-pre-wrap break-words text-error">{message}</p>;
  }

  return <div role="alert" className={`space-y-2 rounded-md border border-error-subtle-border bg-error-subtle text-sm ${compact ? 'p-2' : 'p-3'}`}>
    <p className="font-medium text-error">未配置平台评测模型</p>
    <p className="text-foreground-secondary">当前评估器需要调用平台模型进行评分。请前往「模型注册」，添加模型、测试连接并设为默认。</p>
    {!compact && <p className="text-foreground-secondary">配置完成后，返回评测页面重新评测失败项。已有输出和 Trace 可复用，无需重新执行 Agent。</p>}
    <Button asChild variant="outline" size="sm">
      <Link href="/modelconfig/registry" target="_blank" rel="noopener noreferrer">
        去模型注册<ExternalLink aria-label="新标签页打开" className="size-3" />
      </Link>
    </Button>
    {compact && <p className="text-xs text-foreground-muted">配置完成后，返回评测页面重新评测失败项。</p>}
  </div>;
}
