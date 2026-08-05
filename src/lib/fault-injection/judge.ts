import { OpenAI } from 'openai'
import { getProxyConfig } from '@/lib/ingest/proxy-config'
import { getActiveConfig } from '@/lib/storage/server-config'
import { summarizeTrace } from '@/lib/engine/evaluation/trace-summarizer'
import {
  parseFaultJudgeResponse,
  skippedJudgeResult,
  type FaultJudgeResult,
} from '@/lib/fault-injection/judge-result'
import { buildFaultInjectionJudgePrompt } from '@/prompts/fault-injection-judge'

export type FaultJudgeInput = {
  user?: string | null
  fault: string
  injectionMethod?: string | null
  faultActivated: boolean
  interactions: unknown[]
  injectionEvidence?: Record<string, unknown> | null
  submode?: string | null
}

export type FaultJudgeOutput = FaultJudgeResult & {
  skipped: boolean
  raw?: string
  model?: string | null
}

export async function judgeFaultInjection(input: FaultJudgeInput): Promise<FaultJudgeOutput> {
  if (!input.faultActivated) {
    const skipped = skippedJudgeResult('Fault skill/injection was not activated; judge skipped.')
    return { ...skipped, skipped: true }
  }

  const config = await getActiveConfig(input.user)
  if (!config) {
    return {
      ...skippedJudgeResult('No active model configured in Insight settings.'),
      skipped: true,
      model: null,
    }
  }
  if (!config.model?.trim()) {
    return {
      ...skippedJudgeResult('Active model config has no model id; judge skipped.'),
      skipped: true,
      model: null,
    }
  }
  // Local OpenAI-compatible endpoints may omit apiKey; cloud providers must not
  // silently use a fake placeholder key.
  const apiKey = (config.apiKey || '').trim()
  const baseUrl = (config.baseUrl || '').trim()
  const looksLocal =
    !baseUrl ||
    /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(baseUrl) ||
    baseUrl.startsWith('/')
  if (!apiKey && !looksLocal) {
    return {
      ...skippedJudgeResult('Active model config has no API key; judge skipped.'),
      skipped: true,
      model: config.model,
    }
  }

  const { customFetch } = getProxyConfig()
  const client = new OpenAI({
    apiKey: apiKey || 'local-no-key',
    baseURL: baseUrl || undefined,
    fetch: customFetch,
  })
  const model = config.model.trim()
  const summary = summarizeTrace(input.interactions as any)
  const stepsText = JSON.stringify(summary.steps || summary, null, 2)
  const prompt = buildFaultInjectionJudgePrompt({
    fault: input.fault,
    injectionMethod: input.injectionMethod,
    submode: input.submode,
    stepsText,
    injectionEvidence: input.injectionEvidence || {},
  })

  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: 'You are a fault-injection evaluation judge. Reply with JSON only.' },
      { role: 'user', content: prompt },
    ],
  })
  const raw = completion.choices[0]?.message?.content || ''
  const parsed = parseFaultJudgeResponse(raw)
  return { ...parsed, skipped: false, raw, model }
}
