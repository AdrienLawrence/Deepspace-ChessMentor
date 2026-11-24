/**
 * Server-action registry consumed by src/server/action-routes.ts.
 * The chess and diagnostics handlers forward only to the app RecordRoom in worker.ts;
 * the actual chess command implementation is src/chess/service.ts.
 */

// Server-side SDK helpers and Durable Object implementations: node_modules/deepspace/dist/worker.js.
// Public signatures: node_modules/deepspace/dist/worker.d.ts.
import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { traceEvent } from '../chess/diagnostics'
import { isDiagnosticsOwner } from '../chess/telemetry'

export const actions: Record<string, ActionHandler<Env>> = {
  diagnostics: async ({ userId, env }) => {
    if (!isDiagnosticsOwner(userId, env.OWNER_USER_ID))
      return { success: false, error: 'Only the app owner can view diagnostics.', status: 403 }

    const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
    const result = await stub.fetch(
      new Request('https://internal/internal/chess-diagnostics', {
        method: 'POST',
        headers: { 'X-User-Id': userId, 'X-App-Action': 'true' },
      }),
    )

    if (!result.headers.get('Content-Type')?.includes('application/json')) {
      console.error(JSON.stringify({ event: 'diagnostics.read_failed', status: result.status }))

      return {
        success: false,
        status: 503,
        error: 'Diagnostics storage is temporarily unavailable. Try refreshing shortly.',
      }
    }

    return result.json()
  },
  chess: async ({ userId, params, env }) => {
    const traceId = crypto.randomUUID()
    traceEvent(traceId, 'action.start')
    const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
    const result = await stub.fetch(
      new Request('https://internal/internal/chess', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': userId,
          'X-App-Action': 'true',
          'X-Chess-Trace': traceId,
        },
        body: JSON.stringify(params),
      }),
    )

    return result.json()
  },
}
