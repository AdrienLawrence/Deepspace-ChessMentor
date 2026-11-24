export type FailureCode =
  | 'insufficient_credits'
  | 'rate_limited'
  | 'ai_timeout'
  | 'ai_unavailable'
  | 'ai_configuration'
  | 'invalid_ai_output'
const descriptions: Record<FailureCode, string> = {
  insufficient_credits:
    'AI is paused because the app’s credit balance cannot cover this request. The app owner needs to resolve billing.',
  rate_limited: 'AI is busy or receiving too many requests. Wait a moment before retrying.',
  ai_timeout: 'The AI response timed out. Your game is saved; you can retry.',
  ai_unavailable:
    'The AI service could not complete this request. Your game is saved; you can retry.',
  ai_configuration: 'The AI service configuration needs attention from the app owner.',
  invalid_ai_output: 'The AI returned an unusable response. Your game is saved; you can retry.',
}
export class AiFailure extends Error {
  constructor(
    public code: FailureCode,
    public status?: number,
    public providerRequestId?: string,
  ) {
    super(descriptions[code])
    this.name = 'AiFailure'
  }
}
export function classifyAiFailure(error: unknown): AiFailure {
  if (error instanceof AiFailure) return error
  const e = error as {
    statusCode?: number
    status?: number
    name?: string
    message?: string
    responseBody?: string
    responseHeaders?: Record<string, string>
  } | null
  const status = e?.statusCode ?? e?.status
  // Inspect provider details only to classify. Never log response bodies, prompts or credentials.
  const detail = `${e?.message ?? ''} ${e?.responseBody ?? ''}`.toLowerCase()
  const rawId = e?.responseHeaders?.['x-request-id'] ?? e?.responseHeaders?.['request-id']
  const providerRequestId = rawId && /^[a-zA-Z0-9_-]{1,160}$/.test(rawId) ? rawId : undefined
  const code: FailureCode =
    status === 402 || /insufficient[_ ](credits|quota)|out of credits/.test(detail)
      ? 'insufficient_credits'
      : status === 429
        ? 'rate_limited'
        : e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed? ?out/.test(detail)
          ? 'ai_timeout'
          : status === 400 || status === 401 || status === 403 || status === 404
            ? 'ai_configuration'
            : e instanceof SyntaxError || e?.name === 'ZodError'
              ? 'invalid_ai_output'
              : 'ai_unavailable'
  return new AiFailure(code, status, providerRequestId)
}
export function traceEvent(
  traceId: string,
  stage: string,
  fields: Record<string, string | number | boolean | undefined> = {},
  failed = false,
) {
  const line = JSON.stringify({
    event: 'chess_trace',
    traceId,
    stage,
    ...fields,
    message: `chess_trace ${stage} trace=${traceId}`,
  })
  if (failed) console.error(line)
  else console.info(line)
}
