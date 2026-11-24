import { z } from 'zod'
const query = z
  .object({
    collection: z.enum(['games', 'game_messages', 'move_feedback', 'users', 'settings']),
    where: z.record(z.string().max(80), z.unknown()).optional(),
    orderBy: z.string().max(80).optional(),
    orderDir: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .passthrough()
const subscription = z.object({ subscriptionId: z.string().min(1).max(200), query })
/** Prevent unused Yjs/binary writes and malformed frames reaching SDK error logging. */
export function safeSocketMessage(message: string | ArrayBuffer): string | null {
  if (
    typeof message !== 'string' ||
    message.length > 8192 ||
    new TextEncoder().encode(message).byteLength > 8192
  )
    return null
  try {
    const frame = JSON.parse(message)
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null
    if (frame.type === 'core.subscribe') {
      const parsed = subscription.safeParse(frame.payload)
      if (!parsed.success) return null
      parsed.data.query.limit ??= 1000
      return JSON.stringify({ type: frame.type, payload: parsed.data })
    }
    if (frame.type === 'core.unsubscribe') {
      if (
        typeof frame.payload?.subscriptionId !== 'string' ||
        frame.payload.subscriptionId.length > 200
      )
        return null
    } else if (!['user.list', 'user.update', 'records.list_schemas'].includes(frame.type))
      return null
    return JSON.stringify({
      type: frame.type,
      payload:
        frame.type === 'core.unsubscribe' ? { subscriptionId: frame.payload.subscriptionId } : {},
    })
  } catch {
    return null
  }
}
