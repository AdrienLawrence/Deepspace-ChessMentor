import { describe, expect, it, vi } from 'vitest'
import { AiFailure, classifyAiFailure, traceEvent } from './diagnostics'

describe('AI failure diagnostics', () => {
  it.each([
    [{ statusCode: 402 }, 'insufficient_credits'],
    [
      { statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota"}}' },
      'insufficient_credits',
    ],
    [{ statusCode: 429 }, 'rate_limited'],
    [{ statusCode: 503 }, 'ai_unavailable'],
    [{ statusCode: 401 }, 'ai_configuration'],
    [{ name: 'TimeoutError' }, 'ai_timeout'],
    [new SyntaxError('not json'), 'invalid_ai_output'],
  ])('classifies provider failures without leaking raw details', (input, code) => {
    expect(classifyAiFailure(input).code).toBe(code)
    expect(
      classifyAiFailure({ ...input, message: 'secret-token private prompt' }).message,
    ).not.toContain('secret-token')
  })
  it('preserves a safe provider request ID and omits malformed IDs', () => {
    expect(
      classifyAiFailure({ responseHeaders: { 'x-request-id': 'req_123' } }).providerRequestId,
    ).toBe('req_123')
    expect(
      classifyAiFailure({ responseHeaders: { 'x-request-id': 'secret with spaces\n' } })
        .providerRequestId,
    ).toBeUndefined()
    const failure = new AiFailure('insufficient_credits')
    expect(classifyAiFailure(failure)).toBe(failure)
  })
  it('emits structured failures at error level for filtering by trace ID', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      traceEvent('trace-1', 'model.failed', { code: 'insufficient_credits', durationMs: 12 }, true)
      expect(JSON.parse(log.mock.calls[0][0])).toEqual({
        event: 'chess_trace',
        traceId: 'trace-1',
        stage: 'model.failed',
        message: 'chess_trace model.failed trace=trace-1',
        code: 'insufficient_credits',
        durationMs: 12,
      })
    } finally {
      log.mockRestore()
    }
  })
})
