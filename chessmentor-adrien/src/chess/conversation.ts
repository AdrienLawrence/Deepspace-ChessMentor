import type { Message, Feedback, Row } from './types'

export function coachingTimeline(messages: Row<Message>[], feedback: Row<Feedback>[]) {
  const reflections: Row<Message>[] = feedback.map((f) => ({
    ...f,
    data: {
      playerId: f.data.playerId,
      gameId: f.data.gameId,
      role: 'coach',
      content: f.data.summary,
      linkedPly: f.data.ply,
      positionFen: f.data.positionFen,
      annotations: f.data.annotations,
      status: 'completed',
      requestId: `feedback:${f.recordId}`,
    },
  }))
  return orderMessages([...messages, ...reflections])
}

/** Keep each question before its answer, even when SDK timestamps tie. */
export function orderMessages(messages: Row<Message>[]): Row<Message>[] {
  const turns = new Map<string, string>()
  for (const message of messages) {
    const key = message.data.requestId
    if (!turns.has(key) || message.data.role === 'player') turns.set(key, message.createdAt)
  }
  return [...messages].sort((a, b) => {
    const time = turns.get(a.data.requestId)!.localeCompare(turns.get(b.data.requestId)!)
    if (time) return time
    if (a.data.requestId !== b.data.requestId)
      return a.data.requestId.localeCompare(b.data.requestId)
    return Number(a.data.role === 'coach') - Number(b.data.role === 'coach')
  })
}
