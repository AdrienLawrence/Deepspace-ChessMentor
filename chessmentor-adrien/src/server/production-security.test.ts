/// <reference types="node" />
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import app, { AppRecordRoom, type Env } from '../../worker'
import {
  reserveModel,
  admitRequest,
  admitCreation,
  type LimitStorage,
  type AtomicLimitStorage,
} from '../chess/limits'
import { verifyUserToken } from './auth'
import { safeSocketMessage } from './socket-security'
import { registerSecurity } from './security'
import { newGame } from '../chess/rules'

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
}))
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const issuer = 'https://security-test.invalid'
function jwt(userId: string, claims: Record<string, unknown> = {}, otherKey = false) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(
    JSON.stringify({
      sub: userId,
      iss: issuer,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    }),
  ).toString('base64url')
  const privateKey = otherKey
    ? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
    : keys.privateKey
  return `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

class MemoryStorage implements AtomicLimitStorage {
  values = new Map<string, unknown>()
  private tail: Promise<unknown> = Promise.resolve()
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined
  }
  async put<T>(key: string, value: T) {
    this.values.set(key, structuredClone(value))
  }
  async delete(keys: string[]) {
    for (const key of keys) this.values.delete(key)
    return keys.length
  }
  async list<T>(options: { prefix: string; reverse?: boolean; limit?: number }) {
    let rows = [...this.values]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b))
    if (options.reverse) rows.reverse()
    return new Map(rows.slice(0, options.limit)) as Map<string, T>
  }
  async transaction<T>(callback: (txn: LimitStorage) => Promise<T>) {
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        const snapshot = structuredClone(this.values)
        try {
          return await callback(this)
        } catch (error) {
          this.values = snapshot
          throw error
        }
      })
    this.tail = pending
    return pending
  }
}

function fixture() {
  const db = new DatabaseSync(':memory:')
  const storage = new MemoryStorage()
  const sql = {
    exec(query: string, ...args: (string | number | null)[]) {
      const rows = db.prepare(query).all(...args)
      return {
        toArray: () => rows,
        one: () => rows[0],
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      }
    },
  }
  vi.stubGlobal('WebSocketRequestResponsePair', class {})
  const state = {
    storage: Object.assign(storage, { sql }),
    id: { name: 'app:test' },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
  } as unknown as DurableObjectState
  const upstream = vi.fn(async () => new Response('upstream should not be called', { status: 502 }))
  const env = {
    DEEPSPACE_APP_ID: 'test',
    OWNER_USER_ID: 'owner',
    APP_NAME: 'chessmentor-ai',
    AUTH_JWT_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    AUTH_JWT_ISSUER: issuer,
    APP_OWNER_JWT: jwt('owner', { scope: 'app:test' }),
    APP_IDENTITY_TOKEN: 'secret-test-value',
    API_WORKER: { fetch: upstream },
    PLATFORM_WORKER: { fetch: upstream },
    AUTH_WORKER: { fetch: upstream },
    AUTH_WORKER_URL: issuer,
    ASSETS: {
      fetch: async () => new Response('test page', { headers: { 'Content-Type': 'text/html' } }),
    },
  } as unknown as Env
  const room = new AppRecordRoom(state, env)
  env.RECORD_ROOMS = {
    idFromName: (id: string) => id,
    get: () => room,
  } as unknown as DurableObjectNamespace
  const context = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  async function request(
    path: string,
    body?: unknown,
    user = 'alice',
    extra: Record<string, string> = {},
  ) {
    return app.request(
      `https://app.test${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(user ? { Authorization: `Bearer ${jwt(user)}` } : {}),
          'Content-Type': 'application/json',
          ...extra,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      },
      env,
      context,
    )
  }
  async function tool(tool: string, params: object, user = 'owner', privileged = true) {
    const response = await room.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user,
          ...(privileged ? { 'X-App-Action': 'true' } : {}),
        },
        body: JSON.stringify({ tool, params }),
      }),
    )
    return response.json() as Promise<{
      success: boolean
      data?: { record?: { data: unknown }; records?: unknown[] }
      error?: string
    }>
  }
  return { env, room, storage, request, tool, upstream, db }
}
let f: ReturnType<typeof fixture>
beforeEach(() => {
  generate.mockReset()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  f = fixture()
})
afterEach(() => {
  f.db.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('production HTTP and auth boundaries (real SDK + SQLite, no network)', () => {
  it.each([
    ['', {}],
    ['alice', { exp: 1 }],
    ['alice', { exp: undefined }],
    ['alice', { iss: 'wrong' }],
    ['anon-attacker', {}],
    ['alice', { scope: 'app:test' }],
    ['alice', { sub: {} }],
  ])('rejects unusable identity %s %j', async (user, claims) => {
    expect(await verifyUserToken(f.env, jwt(user, claims))).toBeNull()
  })
  it('accepts signed user tokens and rejects tampering, wrong keys and unsigned tokens', async () => {
    expect((await verifyUserToken(f.env, jwt('alice')))?.userId).toBe('alice')
    expect(await verifyUserToken(f.env, jwt('alice', {}, true))).toBeNull()
    expect(await verifyUserToken(f.env, jwt('alice').slice(0, -10) + 'tampered')).toBeNull()
    expect(await verifyUserToken(f.env, 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJvd25lciJ9.')).toBeNull()
  })
  it.each([
    '/api/integrations/openai/chat-completion',
    '/api/integrations/anthropic/messages',
    '/api/integrations/email/send',
    '/api/files/upload',
    '/_deepspace/charges/create',
    '/api/debug/sql',
    '/api/auth/native-token',
  ])('closes unused endpoint %s before upstream access', async (path) => {
    const response = await f.request(path, {})
    expect([403, 404]).toContain(response.status)
    expect(f.upstream).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })
  it('ignores spoofed owner headers and rejects missing bearer or membership', async () => {
    expect(
      (
        await f.request('/api/actions/chess', {}, '', {
          'X-User-Id': 'owner',
          'X-App-Action': 'true',
          Cookie: 'session=fake',
        })
      ).status,
    ).toBe(401)
    expect((await f.request('/api/actions/chess', {}, 'stranger')).status).toBe(403)
    expect((await f.request('/api/actions/diagnostics', {})).status).toBe(403)
    expect((await f.request('/api/actions/constructor', {})).status).toBe(404)
  })
  it('blocks cross-origin action and WebSocket requests, preserving same-origin access', async () => {
    expect(
      (await f.request('/api/actions/chess', {}, 'owner', { Origin: 'https://evil.test' })).status,
    ).toBe(403)
    expect(
      (
        await f.request('/ws/app:test?token=' + jwt('owner'), undefined, '', {
          Origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await f.request('/api/actions/chess', { op: 'bad' }, 'owner', {
          Origin: 'https://app.test',
        })
      ).status,
    ).toBe(400)
  })
  it('rejects invalid JSON, oversized input and non-JSON content', async () => {
    expect(
      (
        await f.request('/api/actions/chess', 'x'.repeat(20_000), 'owner', {
          'Content-Length': '1',
        })
      ).status,
    ).toBe(413)
    expect((await f.request('/api/auth/sign-out', undefined, '')).status).toBe(405)
    expect((await f.request('/api/actions/chess', '{', 'owner')).status).toBe(400)
    expect((await f.request('/api/actions/chess', 'x'.repeat(20_000), 'owner')).status).toBe(413)
    expect(
      (await f.request('/api/actions/chess', '{}', 'owner', { 'Content-Type': 'text/plain' }))
        .status,
    ).toBe(415)
  })
  it('rejects arbitrary and unused rooms without touching a namespace', async () => {
    const get = vi.spyOn(f.env.RECORD_ROOMS, 'get')
    for (const path of [
      '/ws/arbitrary',
      '/ws/yjs/test',
      '/ws/canvas/test',
      '/ws/jobs/test',
      '/ws/app:test',
    ]) {
      expect([401, 404]).toContain((await f.request(path, undefined, '')).status)
    }
    expect(get).not.toHaveBeenCalled()
  })
  it('sets privacy headers and redacts unexpected errors', async () => {
    const isolated = new Hono()
    registerSecurity(isolated as never)
    isolated.get('/api/fail', () => {
      throw new Error('Bearer actual-secret private prompt')
    })
    const response = await isolated.request('/api/fail')
    expect(response.status).toBe(500)
    expect(await response.text()).not.toMatch(/secret|prompt|Bearer/)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('X-Request-Id')).toBeTruthy()
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('actual-secret')
  })
  it('enforces row ownership and blocks writes through SDK tools, including admin', async () => {
    await f.tool('users.register', { userId: 'alice', name: 'Alice', email: 'alice@example.test' })
    await f.tool('users.register', { userId: 'bob', name: 'Bob', email: 'bob@example.test' })
    expect(
      (
        await f.tool('records.create', {
          collection: 'games',
          recordId: 'alice-game',
          data: newGame('alice', 'w', false),
        })
      ).success,
    ).toBe(true)
    expect(
      (await f.tool('records.get', { collection: 'games', recordId: 'alice-game' }, 'bob', false))
        .success,
    ).toBe(false)
    const read = await f.tool('records.query', { collection: 'games' }, 'bob', false)
    expect(read.data?.records).toHaveLength(0)
    for (const user of ['bob', 'owner'])
      expect(
        (
          await f.tool(
            'records.create',
            { collection: 'games', recordId: 'forged', data: newGame('bob', 'w', false) },
            user,
            false,
          )
        ).success,
      ).toBe(false)
    expect(
      (
        await f.tool(
          'records.update',
          { collection: 'users', recordId: 'bob', data: { role: 'admin' } },
          'bob',
          false,
        )
      ).success,
    ).toBe(false)
  })
  it('denies cross-user chess operations with zero model calls', async () => {
    await f.tool('users.register', { userId: 'bob', name: 'Bob', email: 'bob@example.test' })
    await f.tool('records.create', {
      collection: 'games',
      recordId: 'alice-game',
      data: newGame('alice', 'b', true),
    })
    for (const command of [
      { op: 'opponent', version: 0 },
      {
        op: 'ask',
        requestId: crypto.randomUUID(),
        ply: 0,
        fen: newGame('alice', 'b', true).currentFen,
        question: 'Help',
      },
      { op: 'resign', version: 0 },
    ]) {
      const response = await f.request(
        '/api/actions/chess',
        { gameId: 'alice-game', ...command },
        'bob',
      )
      expect(response.status).toBe(404)
    }
    expect(generate).not.toHaveBeenCalled()
  })
  it('stops at the AI daily budget and preserves saved state, with Retry-After', async () => {
    f.env.CHESS_AI_USER_DAILY = '0'
    await f.tool('records.create', {
      collection: 'games',
      recordId: 'owner-game',
      data: newGame('owner', 'b', true),
    })
    const response = await f.request(
      '/api/actions/chess',
      { op: 'opponent', gameId: 'owner-game', version: 0 },
      'owner',
    )
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(generate).not.toHaveBeenCalled()
    const record = await f.tool('records.get', { collection: 'games', recordId: 'owner-game' })
    expect(record.data?.record?.data).toMatchObject({ version: 0 })
  })
  it('charges every opponent attempt against the budget and never retries a limit failure', async () => {
    f.env.CHESS_AI_USER_DAILY = '1'
    generate.mockResolvedValue({
      text: '{"uci":"e1e8"}',
      usage: { inputTokens: 10, outputTokens: 10 },
      finishReason: 'stop',
    })
    await f.tool('records.create', {
      collection: 'games',
      recordId: 'owner-game',
      data: newGame('owner', 'b', true),
    })
    const response = await f.request(
      '/api/actions/chess',
      { op: 'opponent', gameId: 'owner-game', version: 0 },
      'owner',
    )
    expect(response.status).toBe(429)
    expect(generate).toHaveBeenCalledTimes(1)
    const record = await f.tool('records.get', { collection: 'games', recordId: 'owner-game' })
    expect(record.data?.record?.data).toMatchObject({
      version: 0,
      opponentRetry: { rejected: [{ uci: 'e1e8' }] },
    })
  })
  it.each(['wrong-owner', 'wrong-app', 'expired', 'missing', 'bad-signature'])(
    'fails closed on %s billing credentials before inference',
    async (problem) => {
      f.env.APP_OWNER_JWT =
        problem === 'missing'
          ? ''
          : jwt(
              problem === 'wrong-owner' ? 'other' : 'owner',
              {
                scope: problem === 'wrong-app' ? 'app:other' : 'app:test',
                ...(problem === 'expired' ? { exp: 1 } : {}),
              },
              problem === 'bad-signature',
            )
      await f.tool('records.create', {
        collection: 'games',
        recordId: 'owner-game',
        data: newGame('owner', 'b', true),
      })
      const response = await f.request(
        '/api/actions/chess',
        { op: 'opponent', gameId: 'owner-game', version: 0 },
        'owner',
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ code: 'ai_configuration' })
      expect(generate).not.toHaveBeenCalled()
    },
  )
  it('denies internal-path spoofing and blocked accounts', async () => {
    expect(
      (
        await f.request('/internal/chess', { op: 'create' }, '', {
          'X-App-Action': 'true',
          'X-User-Id': 'owner',
        })
      ).status,
    ).toBe(404)
    f.env.CHESS_BLOCKED_USER_IDS = 'alice'
    expect(await verifyUserToken(f.env, jwt('alice'))).toBeNull()
    expect((await f.request('/api/actions/chess', {}, 'alice')).status).toBe(401)
  })
  it('keeps operational tools owner-only and returns credential status without secret values', async () => {
    await f.tool('users.register', { userId: 'alice', name: 'Alice', email: 'alice@example.test' })
    expect(
      (await f.request('/_deepspace/agent/browser/tools/security_status', { input: {} }, 'alice'))
        .status,
    ).toBe(403)
    const response = await f.request(
      '/_deepspace/agent/browser/tools/security_status',
      { input: {} },
      'owner',
    )
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('appDailyLimit')
    expect(body).toContain('"valid":true')
    expect(body).not.toContain(f.env.APP_OWNER_JWT)
    expect(body).not.toContain(f.env.APP_IDENTITY_TOKEN)
    expect(generate).not.toHaveBeenCalled()
  })
  it('enforces socket expiry, frame rate and read ownership using real SDK queries', async () => {
    await f.tool('records.create', {
      collection: 'games',
      recordId: 'alice-game',
      data: newGame('alice', 'w', false),
    })
    let attachment = {
      userId: 'bob',
      role: 'member',
      chessExpires: Date.now() + 60_000,
      chessWindow: { start: Date.now(), count: 0 },
      subscriptions: [],
      yjsSubscriptions: [],
    }
    const socket = {
      readyState: 1,
      deserializeAttachment: () => attachment,
      serializeAttachment: (next: typeof attachment) => {
        attachment = next
      },
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket
    await f.room.webSocketMessage(
      socket,
      JSON.stringify({
        type: 'core.subscribe',
        payload: { subscriptionId: 'x', query: { collection: 'games' } },
      }),
    )
    expect(
      JSON.parse(vi.mocked(socket.send).mock.calls[0][0] as string).payload.records,
    ).toHaveLength(0)
    attachment.chessWindow.count = 120
    await f.room.webSocketMessage(socket, 'ping')
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String))
    vi.mocked(socket.close).mockClear()
    attachment.chessExpires = 1
    await f.room.webSocketMessage(socket, 'ping')
    expect(socket.close).toHaveBeenCalledWith(1008, 'Session refresh required')
  })
})

describe('persistent, atomic abuse limits', () => {
  it('caps simultaneous reservations across users without races and releases leases', async () => {
    const storage = new MemoryStorage()
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => reserveModel(storage, `user${i}`, {})),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4)
    for (const result of results) if (result.status === 'fulfilled') await result.value()
    const release = await reserveModel(storage, 'new-user', {})
    await release()
  })
  it('counts failures/retries, survives a new caller and resets daily UTC windows', async () => {
    const storage = new MemoryStorage(),
      now = Date.UTC(2026, 10, 23, 12)
    for (let i = 0; i < 2; i++) {
      const release = await reserveModel(storage, 'alice', { CHESS_AI_USER_DAILY: '2' }, now)
      await release()
    }
    await expect(
      reserveModel(storage, 'alice', { CHESS_AI_USER_DAILY: '2' }, now + 61_000),
    ).rejects.toMatchObject({ status: 429, code: 'usage_limit' })
    await expect(
      reserveModel(storage, 'alice', { CHESS_AI_USER_DAILY: '2' }, now + 86_400_000),
    ).resolves.toBeTypeOf('function')
  })
  it('enforces aggregate budgets, kill switch and invalid configuration fail-closed', async () => {
    const storage = new MemoryStorage()
    const release = await reserveModel(storage, 'alice', { CHESS_AI_APP_DAILY: '1' })
    await release()
    await expect(reserveModel(storage, 'bob', { CHESS_AI_APP_DAILY: '1' })).rejects.toMatchObject({
      status: 429,
    })
    await expect(reserveModel(storage, 'bob', { CHESS_AI_ENABLED: 'false' })).rejects.toMatchObject(
      { code: 'ai_paused' },
    )
    await expect(
      reserveModel(storage, 'bob', { CHESS_AI_USER_DAILY: 'NaN' }),
    ).rejects.toMatchObject({ status: 503 })
  })
  it('limits requests and creations persistently', async () => {
    const storage = new MemoryStorage()
    for (let i = 0; i < 30; i++) await admitRequest(storage, 'alice')
    await expect(admitRequest(storage, 'alice')).rejects.toMatchObject({ status: 429 })
    for (let i = 0; i < 10; i++) await admitCreation(storage, 'alice')
    await expect(admitCreation(storage, 'alice')).rejects.toMatchObject({ status: 429 })
  })
})

describe('realtime input bounds', () => {
  it.each([
    '{',
    JSON.stringify({ type: 'core.put', payload: {} }),
    JSON.stringify({ type: 'yjs.join', payload: {} }),
    'x'.repeat(9000),
    JSON.stringify({
      type: 'core.subscribe',
      payload: { subscriptionId: 'x', query: { collection: 'sqlite_master' } },
    }),
  ])('rejects malformed, mutation and unused frames', (frame) =>
    expect(safeSocketMessage(frame)).toBeNull(),
  )
  it('bounds legitimate subscriptions and denies binary messages', () => {
    expect(
      JSON.parse(
        safeSocketMessage(
          JSON.stringify({
            type: 'core.subscribe',
            payload: { subscriptionId: 'x', query: { collection: 'games' } },
          }),
        )!,
      ).payload.query.limit,
    ).toBe(1000)
    expect(safeSocketMessage(new ArrayBuffer(1))).toBeNull()
  })
})
