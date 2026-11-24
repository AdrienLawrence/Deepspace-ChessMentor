import { describe, expect, it, vi } from 'vitest'
// Server-side SDK helpers and Durable Object implementations: node_modules/deepspace/dist/worker.js.
// Public signatures: node_modules/deepspace/dist/worker.d.ts.
import { canRead, canCreate, canUpdate, canDelete } from 'deepspace/worker'
import { executeChess, SerialQueue, type Store } from './service'
import { parseCoaching, parseJson, type ModelCall } from './ai'
import { newGame, positionAt } from './rules'
import { chessSchemas } from '../schemas/chess-schema'
import type { Game, Message, Row } from './types'
import { orderMessages } from './conversation'
import { AiFailure } from './diagnostics'

class MemoryStore implements Store {
  rows = new Map<string, Row<unknown>>()
  async get<T>(c: string, id: string) {
    return structuredClone(this.rows.get(c + id) as Row<T> | undefined) ?? null
  }
  async put<T extends object>(c: string, id: string, data: T) {
    const old = this.rows.get(c + id)
    this.rows.set(c + id, {
      recordId: id,
      data: structuredClone(data),
      createdAt: old?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }
  async query<T>(c: string, where: Record<string, unknown>, limit: number) {
    return [...this.rows.entries()]
      .filter(
        ([key, row]) =>
          key.startsWith(c) &&
          Object.entries(where).every(([k, v]) => (row.data as Record<string, unknown>)[k] === v),
      )
      .map(([, row]) => structuredClone(row as Row<T>))
      .reverse()
      .slice(0, limit)
  }
}

const coaching = {
  content: 'Consider how your central pawns support your pieces.',
  annotations: [{ type: 'highlight', square: 'e4', tone: 'yellow' }],
}

async function fixture(color: 'w' | 'b' = 'w', automaticFeedback = true) {
  const store = new MemoryStore()
  const model = vi.fn<ModelCall>().mockResolvedValue(coaching)
  const created = await executeChess(
    'alice',
    { op: 'create', color, automaticFeedback, requestId: crypto.randomUUID() },
    store,
    model,
  )
  const run = (command: object, userId = 'alice') =>
    executeChess(userId, { gameId: created.gameId, ...command }, store, model)
  const game = async () => (await store.get<Game>('games', created.gameId))!.data

  return { store, model, run, game, id: created.gameId }
}

describe('persistent operations and privacy', () => {
  it.each([
    [0, 'w'],
    [255, 'b'],
  ] as const)(
    'assigns random side %s once without changing piece colors',
    async (sample, color) => {
      const random = vi.spyOn(crypto, 'getRandomValues').mockReturnValue(new Uint8Array([sample]))

      try {
        const store = new MemoryStore()
        const model = vi.fn<ModelCall>()
        const command = {
          op: 'create',
          color: 'random',
          automaticFeedback: false,
          requestId: crypto.randomUUID(),
        }
        const created = await executeChess('alice', command, store, model)
        await executeChess('alice', command, store, model)
        const game = (await store.get<Game>('games', created.gameId))!.data
        expect(game.playerColor).toBe(color)
        expect(game.currentFen).toBe(newGame('alice', color, false).currentFen)
        expect(game.moveHistory).toEqual([])
        expect(random).toHaveBeenCalledTimes(1)
        expect(model).not.toHaveBeenCalled()
      } finally {
        random.mockRestore()
      }
    },
  )
  it('deduplicates creation across retries and resolves random color', async () => {
    const store = new MemoryStore()
    const model = vi.fn<ModelCall>()
    const command = {
      op: 'create',
      color: 'random',
      automaticFeedback: false,
      requestId: crypto.randomUUID(),
    }
    const first = await executeChess('alice', command, store, model)
    const again = await executeChess('alice', command, store, model)
    expect(first).toEqual(again)
    expect(store.rows.size).toBe(1)
    expect(['w', 'b']).toContain((await store.get<Game>('games', first.gameId))!.data.playerColor)
    expect(model).not.toHaveBeenCalled()
  })
  it.each(['move', 'opponent', 'resign', 'feedback', 'ask', 'branch'])(
    'denies another user access through %s',
    async (op) => {
      const f = await fixture()
      await expect(
        f.run(
          {
            op,
            version: 0,
            uci: 'e2e4',
            ply: 1,
            fen: newGame('alice', 'w', false).currentFen,
            question: 'Help?',
            requestId: crypto.randomUUID(),
          },
          'bob',
        ),
      ).rejects.toThrow(/access denied/)
      expect(f.model).not.toHaveBeenCalled()
    },
  )
  it('rejects anonymous creation', async () => {
    const f = await fixture()
    await expect(
      executeChess(
        'anon-guest',
        { op: 'create', color: 'w', automaticFeedback: false, requestId: crypto.randomUUID() },
        f.store,
        f.model,
      ),
    ).rejects.toThrow(/Sign in/)
  })
  it('persists moves and protects versions', async () => {
    const f = await fixture()
    await f.run({ op: 'move', version: 0, uci: 'e2e4' })
    await expect(f.run({ op: 'move', version: 0, uci: 'd2d4' })).rejects.toThrow(/position changed/)
    expect((await f.game()).moveHistory.map((m) => m.san)).toEqual(['e4'])
  })
  it('validates malformed/illegal opponent output, then retries a legal move', async () => {
    const f = await fixture('b')
    f.model.mockResolvedValueOnce({ uci: 'e2e5' }).mockResolvedValueOnce({ uci: 'e2e4' })
    await f.run({ op: 'opponent', version: 0 })
    expect((await f.game()).moveHistory).toHaveLength(1)
    expect(f.model).toHaveBeenCalledTimes(2)
    await f.run({ op: 'opponent', version: 0 })
    expect(f.model).toHaveBeenCalledTimes(2)
  })
  it('failed generation leaves the game recoverable without invented moves', async () => {
    const f = await fixture('b')
    f.model.mockRejectedValue(new Error('Provider offline'))
    await expect(f.run({ op: 'opponent', version: 0 })).rejects.toThrow(/Retry opponent/)
    expect((await f.game()).version).toBe(0)
    f.model.mockResolvedValue({ uci: 'g1f3' })
    await f.run({ op: 'opponent', version: 0 })
    expect((await f.game()).version).toBe(1)
  })
  it('continues persisted rejection history across manual retries and clears it on commit', async () => {
    const f = await fixture('b')
    f.model.mockResolvedValueOnce({ uci: 'e2e5' }).mockResolvedValueOnce({ uci: 'd2d5' })
    await expect(f.run({ op: 'opponent', version: 0 })).rejects.toThrow(/Retry opponent/)
    const retry = (await f.game()).opponentRetry!
    expect(retry.rejected.map((x) => x.uci)).toEqual(['e2e5', 'd2d5'])
    expect(f.model.mock.calls[0][1]).toMatchObject({ rejectedMoves: [] })
    expect(f.model.mock.calls[1][1]).toMatchObject({ rejectedMoves: [{ uci: 'e2e5' }] })
    f.model.mockResolvedValueOnce({ uci: 'e2e5' }).mockResolvedValueOnce({ uci: 'e2e4' })
    await f.run({ op: 'opponent', version: 0 })
    expect(f.model.mock.calls[2][1]).toMatchObject({ rejectedMoves: retry.rejected })
    expect(f.model.mock.calls[3][1]).toMatchObject({ rejectedMoves: retry.rejected })
    expect((await f.game()).opponentRetry).toBeNull()
    await f.run({ op: 'move', version: 1, uci: 'e7e5' })
    f.model.mockResolvedValueOnce({ uci: 'g1f3' })
    await f.run({ op: 'opponent', version: 2 })
    expect(f.model.mock.calls[4][1]).toMatchObject({ rejectedMoves: [] })
  })
  it('persists correction context before a subsequent billing failure without retrying it', async () => {
    const f = await fixture('b')
    f.model
      .mockResolvedValueOnce({ uci: 'e2e5' })
      .mockRejectedValueOnce(new AiFailure('insufficient_credits'))
    await expect(f.run({ op: 'opponent', version: 0 })).rejects.toMatchObject({
      code: 'insufficient_credits',
    })
    expect(f.model).toHaveBeenCalledTimes(2)
    expect((await f.game()).opponentRetry?.rejected).toHaveLength(1)
    expect((await f.game()).version).toBe(0)
  })
  it('does not spend on a second attempt if saving rejection history fails', async () => {
    const f = await fixture('b')
    f.model.mockResolvedValue({ uci: 'e2e5' })
    vi.spyOn(f.store, 'put').mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(f.run({ op: 'opponent', version: 0 })).rejects.toThrow('storage unavailable')
    expect(f.model).toHaveBeenCalledTimes(1)
  })
  it('supplies verified alternatives and distinguishes live feedback from history', async () => {
    const f = await fixture()
    await f.run({ op: 'move', version: 0, uci: 'e2e4' })
    await f.run({ op: 'feedback', ply: 1 })
    expect(f.model.mock.calls[0][1]).toMatchObject({ livePosition: true, wasOnlyLegalMove: false })
    expect(
      (f.model.mock.calls[0][1] as { legalAlternatives: unknown[] }).legalAlternatives,
    ).toHaveLength(20)
  })
  it('does not generate or commit after completion', async () => {
    const f = await fixture('b')
    await f.run({ op: 'resign', version: 0 })
    await f.run({ op: 'opponent', version: 0 })
    expect(f.model).not.toHaveBeenCalled()
    await expect(f.run({ op: 'move', version: 1, uci: 'e2e4' })).rejects.toThrow(/ended/)
  })
  it('uses exact historical FEN, saves conversations and deduplicates retries', async () => {
    const f = await fixture()
    await f.run({ op: 'move', version: 0, uci: 'e2e4' })
    const command = {
      op: 'ask',
      ply: 0,
      fen: positionAt(await f.game(), 0),
      question: 'What matters here?',
      requestId: crypto.randomUUID(),
    }
    await f.run(command)
    await f.run(command)
    expect(f.model).toHaveBeenCalledTimes(1)
    expect(f.model.mock.calls[0][1]).toMatchObject({
      ply: 0,
      fen: command.fen,
      mode: 'historical analysis',
    })
    const messages = await f.store.query<Message>('game_messages', { gameId: f.id }, 20)
    expect(messages).toHaveLength(2)
    expect(messages.every((m) => m.data.positionFen === command.fen)).toBe(true)
    expect(messages.find((m) => m.data.role === 'coach')?.data.annotations).toHaveLength(1)
    expect((await f.game()).moveHistory).toHaveLength(1)
  })
  it('preserves conversation context for follow-up questions', async () => {
    const f = await fixture()
    const fen = (await f.game()).currentFen
    await f.run({
      op: 'ask',
      ply: 0,
      fen,
      question: 'What should I notice?',
      requestId: crypto.randomUUID(),
    })
    await f.run({
      op: 'ask',
      ply: 0,
      fen,
      question: 'Why does that matter?',
      requestId: crypto.randomUUID(),
    })
    expect(JSON.stringify(f.model.mock.calls[1][1])).toContain(coaching.content)
    expect(f.model.mock.calls[1][1]).toMatchObject({ mode: 'live foresight coaching' })
  })
  it('rejects incorrect position references before inference', async () => {
    const f = await fixture()
    await expect(
      f.run({ op: 'ask', ply: 0, fen: 'wrong', question: 'Help?', requestId: crypto.randomUUID() }),
    ).rejects.toThrow(/different board/)
    expect(f.model).not.toHaveBeenCalled()
  })
  it('retries failed coaching without duplicating either message', async () => {
    const f = await fixture()
    const command = {
      op: 'ask',
      ply: 0,
      fen: (await f.game()).currentFen,
      question: 'Help?',
      requestId: crypto.randomUUID(),
    }
    f.model.mockRejectedValueOnce(new Error('Timeout'))
    await expect(f.run(command)).rejects.toThrow(/question is saved/)
    expect(
      (await f.store.query<Message>('game_messages', { gameId: f.id }, 10)).some(
        (m) => m.data.status === 'failed',
      ),
    ).toBe(true)
    await f.run(command)
    const rows = await f.store.query<Message>('game_messages', { gameId: f.id }, 10)
    expect(rows).toHaveLength(2)
    expect(rows.every((m) => m.data.status === 'completed')).toBe(true)
  })
  it('caches feedback by game and ply', async () => {
    const f = await fixture()
    await f.run({ op: 'move', version: 0, uci: 'e2e4' })
    await f.run({ op: 'feedback', ply: 1 })
    await f.run({ op: 'feedback', ply: 1 })
    expect(f.model).toHaveBeenCalledTimes(1)
    expect(await f.store.query('move_feedback', { gameId: f.id }, 10)).toHaveLength(1)
  })
  it('branches a historical position, preserves the original and deduplicates retries', async () => {
    const f = await fixture()
    await f.run({ op: 'move', version: 0, uci: 'e2e4' })
    f.model.mockResolvedValue({ uci: 'e7e5' })
    await f.run({ op: 'opponent', version: 1 })
    await f.run({ op: 'resign', version: 2 })
    const original = await f.game()
    const command = {
      op: 'branch',
      ply: 1,
      fen: positionAt(original, 1),
      uci: 'c7c5',
      requestId: crypto.randomUUID(),
    }
    const created = await f.run(command)
    expect(await f.run(command)).toEqual(created)
    expect(await f.game()).toEqual(original)
    const branch = (await f.store.get<Game>('games', created.gameId))!.data
    expect(branch.moveHistory.map((m) => m.san)).toEqual(['e4', 'c5'])
    expect(branch).toMatchObject({
      status: 'active',
      result: '*',
      reason: '',
      parentGameId: f.id,
      branchPly: 1,
      playerColor: 'w',
      version: 2,
    })
    expect(f.model).toHaveBeenCalledTimes(1)
    expect(await f.store.query('game_messages', { gameId: created.gameId }, 20)).toEqual([])
    await expect(f.run({ ...command, uci: 'e7e6' })).rejects.toThrow(/different idea/)
  })
  it('rejects illegal, unchanged, latest and mismatched branch positions without creating games', async () => {
    const f = await fixture()
    await f.run({ op: 'move', version: 0, uci: 'e2e4' })
    const base = {
      op: 'branch',
      ply: 0,
      fen: positionAt(await f.game(), 0),
      uci: 'd2d4',
      requestId: crypto.randomUUID(),
    }

    for (const change of [{ uci: 'e2e5' }, { uci: 'e2e4' }, { ply: 1 }, { fen: 'invalid' }])
      await expect(f.run({ ...base, ...change })).rejects.toThrow()

    expect(f.store.rows.size).toBe(1)
    expect(f.model).not.toHaveBeenCalled()
  })
  it.each(['insufficient_credits', 'ai_configuration', 'rate_limited', 'ai_timeout'] as const)(
    'does not retry opponent calls after %s',
    async (code) => {
      const f = await fixture('b')
      f.model.mockRejectedValue(new AiFailure(code))
      await expect(f.run({ op: 'opponent', version: 0 })).rejects.toMatchObject({ code })
      expect(f.model).toHaveBeenCalledTimes(1)
      expect((await f.game()).moveHistory).toEqual([])
    },
  )
  it('retains a useful credit failure in the saved conversation', async () => {
    const f = await fixture()
    f.model.mockRejectedValue(new AiFailure('insufficient_credits', 402))
    await expect(
      f.run({
        op: 'ask',
        ply: 0,
        fen: (await f.game()).currentFen,
        question: 'Help?',
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'insufficient_credits' })
    const rows = await f.store.query<Message>('game_messages', { gameId: f.id }, 20)
    expect(rows.find((r) => r.data.role === 'coach')?.data).toMatchObject({
      status: 'failed',
      content: expect.stringContaining('credit balance'),
    })
  })
  it('serializes competing tabs so exactly one stale move is rejected', async () => {
    const f = await fixture()
    const queue = new SerialQueue()
    const results = await Promise.allSettled(
      ['e2e4', 'd2d4'].map((uci) =>
        queue.run('alice', () => f.run({ op: 'move', version: 0, uci })),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await f.game()).version).toBe(1)
  })
  it('serializes duplicate opponent requests into one inference and one move', async () => {
    const f = await fixture('b')
    const queue = new SerialQueue()
    f.model.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))

      return { uci: 'e2e4' }
    })
    await Promise.all(
      [1, 2].map(() => queue.run('alice', () => f.run({ op: 'opponent', version: 0 }))),
    )
    expect(f.model).toHaveBeenCalledTimes(1)
    expect((await f.game()).version).toBe(1)
  })
  it('lets another owner proceed while one owner waits, and releases failed queues', async () => {
    const queue = new SerialQueue()
    const events: string[] = []
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = queue.run('alice', async () => {
      await blocker
      events.push('a')
      throw new Error('fail')
    })
    const handled = a.catch(() => {})
    await queue.run('bob', async () => {
      events.push('b')
    })
    expect(events).toEqual(['b'])
    release()
    await handled
    await queue.run('alice', async () => {
      events.push('retry')
    })
    expect(events).toEqual(['b', 'a', 'retry'])
  })
  it('actual SDK policies deny private reads and all direct mutations, even for admin', () => {
    for (const schema of chessSchemas) {
      const row = { data: { playerId: 'alice' }, createdBy: 'alice' }

      for (const role of ['member', 'admin']) {
        expect(canRead(schema, role, row, 'alice')).toBe(true)
        expect(canRead(schema, role, row, 'bob')).toBe(false)
        expect(canCreate(schema, role)).toBe(false)
        expect(canUpdate(schema, role, row, 'alice')).toBe(false)
        expect(canDelete(schema, role, row, 'alice')).toBe(false)
      }

      expect(canRead(schema, 'viewer', row, 'anon-guest')).toBe(false)
    }
  })
})

describe('model output trust boundary', () => {
  it('orders questions before answers when persistence timestamps tie', () => {
    const base: Message = {
      playerId: 'alice',
      gameId: 'g',
      role: 'player',
      content: 'Question',
      linkedPly: 0,
      positionFen: '',
      annotations: [],
      status: 'completed',
      requestId: 'turn',
    }
    const question: Row<Message> = {
      recordId: 'turn-player',
      data: base,
      createdAt: '2026-11-23T00:00:00Z',
      updatedAt: '2026-11-23T00:00:00Z',
    }
    const answer: Row<Message> = {
      ...question,
      recordId: 'turn-coach',
      data: { ...base, role: 'coach' },
    }
    expect(orderMessages([answer, question]).map((m) => m.data.role)).toEqual(['player', 'coach'])
  })
  it('preserves useful text while removing malformed annotations', () => {
    const response = parseCoaching({
      content: 'Look at e4.',
      annotations: [
        coaching.annotations[0],
        { type: 'arrow', from: 'z9', to: 'e4', tone: 'red' },
        { type: 'html', content: '<script>' },
        { type: 'highlight', square: 'e4', tone: 'purple' },
      ],
    })
    expect(response.content).toBe('Look at e4.')
    expect(response.annotations).toEqual(coaching.annotations)
  })
  it('bounds annotation counts and rejects missing coaching text', () => {
    expect(
      parseCoaching({ ...coaching, annotations: Array(50).fill(coaching.annotations[0]) })
        .annotations,
    ).toHaveLength(16)
    expect(() => parseCoaching({ annotations: [] })).toThrow()
    expect(() => parseCoaching({ content: '' })).toThrow()
  })
  it('accepts fenced JSON but rejects malformed output', () => {
    expect(parseJson('```json\n{"uci":"e2e4"}\n```')).toEqual({ uci: 'e2e4' })
    expect(() => parseJson('I would play e4')).toThrow()
  })
})
