import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppContext, Env } from '../../worker'

const { action } = vi.hoisted(() => ({ action: vi.fn() }))

vi.mock('../actions/index.js', () => ({ actions: { chess: action } }))

vi.mock('deepspace/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('deepspace/worker')>()),
  resolveAppMembership: async () => ({ member: true, role: 'member' }),
}))

import { registerActionRoutes } from './action-routes'

describe('chess HTTP failure visibility', () => {
  it.each([402, 429, 503, 504, 400])(
    'preserves status %s and the trace reference',
    async (status) => {
      const app = new Hono<AppContext>()
      registerActionRoutes(app, async () => ({ userId: 'alice' }) as never)
      action.mockResolvedValue({
        success: false,
        error: 'Safe explanation',
        code: 'test_failure',
        status,
        details: { traceId: 'trace-123' },
      })
      const env = { RECORD_ROOMS: { idFromName: () => 'test', get: () => ({}) } } as unknown as Env
      const response = await app.request(
        '/api/actions/chess',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
          body: '{}',
        },
        env,
      )
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({
        success: false,
        details: { traceId: 'trace-123' },
      })
    },
  )
})
