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
