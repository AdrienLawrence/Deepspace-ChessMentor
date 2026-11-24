/**
 * Browser-to-server command transport. DeepSpace supplies the current user token.
 * The endpoint is registered in src/server/action-routes.ts; src/actions/index.ts
 * forwards chess commands to worker.ts, which calls src/chess/service.ts.
 * Saved records return to the UI through DeepSpace useQuery subscriptions.
 */

// Browser authentication, hooks and data providers: node_modules/deepspace/dist/index.js.
// Public signatures: node_modules/deepspace/dist/index.d.ts.
import { getAuthToken } from 'deepspace'
import type { Command } from './types'

export async function chessAction(command: Command): Promise<{ gameId: string }> {
  const token = await getAuthToken()

  if (!token) throw new Error('Please sign in to continue.')

  const response = await fetch('/api/actions/chess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(command),
  })
  const result = (await response.json()) as {
    success: boolean
    data: { gameId: string }
    error?: string
    details?: { traceId?: string }
  }

  if (!response.ok || !result.success)
    throw new Error(
      (result.error || 'The request failed. Please try again.') +
        (result.details?.traceId ? ` Reference: ${result.details.traceId}` : ''),
    )

  return result.data
}
