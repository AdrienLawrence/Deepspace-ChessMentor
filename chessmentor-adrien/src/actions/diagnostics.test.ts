import { describe, it, expect, vi } from 'vitest'
import { actions } from './index'
// Server-side SDK helpers and Durable Object implementations: node_modules/deepspace/dist/worker.js.
// Public signatures: node_modules/deepspace/dist/worker.d.ts.
import type { ActionContext } from 'deepspace/worker'
import type { Env } from '../../worker'

describe('diagnostics action authorization', () => {
  it('does not contact storage for other users even if they supply an owner ID', async () => {
    const get = vi.fn()
    const result = await actions.diagnostics({
      userId: 'other-admin',
      params: { userId: 'owner' },
      env: { OWNER_USER_ID: 'owner', RECORD_ROOMS: { get } },
    } as unknown as ActionContext<Env>)
    expect(result).toMatchObject({ success: false, status: 403 })
    expect(get).not.toHaveBeenCalled()
  })
  it('uses the authenticated owner identity for the private read', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({ success: true, data: { traces: [] } }),
    )
    const result = await actions.diagnostics({
      userId: 'owner',
      params: {},
      env: {
        OWNER_USER_ID: 'owner',
        DEEPSPACE_APP_ID: 'app',
        RECORD_ROOMS: { idFromName: () => 'id', get: () => ({ fetch }) },
      },
    } as unknown as ActionContext<Env>)
    expect(result).toMatchObject({ success: true })
    const request = fetch.mock.calls[0][0] as Request
    expect(request.headers.get('X-User-Id')).toBe('owner')
    expect(request.method).toBe('POST')
    expect(new URL(request.url).pathname).toBe('/internal/chess-diagnostics')
  })
})
