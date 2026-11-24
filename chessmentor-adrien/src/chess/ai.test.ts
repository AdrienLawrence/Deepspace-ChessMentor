import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../worker'
const { generate, factory } = vi.hoisted(() => ({
  generate: vi.fn(),
  factory: vi.fn(() => 'mock-model'),
}))
vi.mock('ai', () => ({ generateText: generate }))
vi.mock('deepspace/worker', () => ({
  createDeepSpaceAI: () => factory,
  verifyJwt: async () => ({
    result: { userId: 'owner', claims: { scope: 'app:test', exp: Date.now() / 1000 + 3600 } },
  }),
}))
const env = { APP_OWNER_JWT: 'test-only', OWNER_USER_ID: 'owner', DEEPSPACE_APP_ID: 'test' } as Env
import { modelCall } from './ai'

describe('AI boundary (no network)', () => {
  beforeEach(() => {
    generate.mockReset()
    factory.mockClear()
  })
  it('logs purpose and tokens without logging private text or changing the model budget', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      generate.mockResolvedValue({
        text: '{"uci":"e2e4"}',
        usage: { inputTokens: 120, outputTokens: 12 },
        finishReason: 'stop',
      })
      for (const purpose of ['opponent', 'feedback', 'mentor'] as const)
        await modelCall(env, 'trace-123')(
          'private prompt',
          { question: 'private question' },
          purpose,
        )
      expect(generate.mock.calls.map(([options]) => options.maxOutputTokens)).toEqual([
        2200, 2200, 2200,
      ])
      expect(generate.mock.calls.every(([options]) => options.maxRetries === 0)).toBe(true)
      const logs = log.mock.calls.map(([line]) => JSON.parse(line))
      expect(logs.filter((l) => l.stage === 'model.complete')).toHaveLength(3)
      expect(logs[1]).toMatchObject({ traceId: 'trace-123', inputTokens: 120, outputTokens: 12 })
      expect(JSON.stringify(logs)).not.toMatch(/private prompt|private question|e2e4/)
    } finally {
      log.mockRestore()
    }
  })
  it('preserves a credit error without retrying or leaking provider response details', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      generate.mockRejectedValue({
        statusCode: 402,
        responseBody: 'private provider body',
        responseHeaders: { 'x-request-id': 'req_abc' },
      })
      await expect(modelCall(env, 'trace-123')('secret', {})).rejects.toMatchObject({
        code: 'insufficient_credits',
      })
      expect(generate).toHaveBeenCalledTimes(1)
      expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({
        code: 'insufficient_credits',
        status: 402,
        providerRequestId: 'req_abc',
      })
      expect(JSON.stringify(error.mock.calls)).not.toContain('private provider body')
    } finally {
      info.mockRestore()
      error.mockRestore()
    }
  })
})
