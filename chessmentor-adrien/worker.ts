/**
 * App Worker — explicit assembly for DeepSpace app routes and Durable Objects.
 *
 * Route implementations live under src/server. Keep their registration order
 * here: specific API and WebSocket handlers must precede the SPA fallback.
 */

import { Hono } from 'hono'
import {
  armCronRoom,
  CanvasRoom,
  CronRoom,
  JobRoom,
  PresenceRoom,
  RecordRoom,
  resolveAppRole,
  YjsRoom,
} from 'deepspace/worker'
import type { DOBindings, DOManifest, Job, JobContext } from 'deepspace/worker'
import { AI_CHATS_SCHEMA } from 'deepspace/schema'
import { registerAgent } from './src/ai/agent.js'
import { buildTools } from './src/ai/tools.js'
import { tasks as cronTasks, runTask as runCronTask } from './src/cron.js'
import { runJob } from './src/jobs.js'
import { schemas } from './src/schemas.js'
import { executeChess, SerialQueue, type Store } from './src/chess/service'
import { registerSecurity, securityEvent } from './src/server/security'
import { safeSocketMessage } from './src/server/socket-security'
import { ChessError } from './src/chess/errors'
import { ZodError } from 'zod'
import { admitRequest, admitCreation, reserveModel, readUsage } from './src/chess/limits'
import { modelCall, aiCredentialStatus } from './src/chess/ai'
import { AiFailure, traceEvent } from './src/chess/diagnostics'
import {
  createRequestTrace,
  saveTrace,
  readTraces,
  isDiagnosticsOwner,
} from './src/chess/telemetry'
import { commandSchema, type Row } from './src/chess/types'
import { registerActionRoutes } from './src/server/action-routes.js'
import {
  registerAuthAndIntegrationRoutes,
  registerPlatformProxyRoutes,
  registerStaticRoutes,
  resolveAuth,
} from './src/server/http-routes.js'
import { registerRealtimeRoutes } from './src/server/realtime-routes.js'

// Dynamic deploy reads this manifest to create the app's DO bindings.
export const __DO_MANIFEST__ = [
  { binding: 'RECORD_ROOMS', className: 'AppRecordRoom', sqlite: true },
  { binding: 'YJS_ROOMS', className: 'AppYjsRoom', sqlite: true },
  { binding: 'CANVAS_ROOMS', className: 'AppCanvasRoom', sqlite: true },
  { binding: 'PRESENCE_ROOMS', className: 'AppPresenceRoom', sqlite: true },
  { binding: 'CRON_ROOMS', className: 'AppCronRoom', sqlite: true },
  { binding: 'JOB_ROOMS', className: 'AppJobRoom', sqlite: true },
] as const satisfies DOManifest

export class AppRecordRoom extends RecordRoom<Env> {
  private chessQueue = new SerialQueue()
  private chessEnv: Env
  private chessState: DurableObjectState
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, schemas, { ownerUserId: env.OWNER_USER_ID })
    this.chessEnv = env
    this.chessState = state
    // Validate expiry on heartbeat too; automatic pong would bypass this check.
    state.setWebSocketAutoResponse()
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/ws/')) {
      const sockets = this.chessState.getWebSockets()
      const encoded = request.headers.get('X-User-Id') ?? ''
      const userId = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
      const expires = Math.min(
        Number(request.headers.get('X-Chess-Session-Expires')) * 1000,
        Date.now() + 15 * 60_000,
      )
      if (!userId || !Number.isFinite(expires) || expires <= Date.now())
        return new Response('Unauthorized', { status: 401 })
      if (
        sockets.length >= 200 ||
        sockets.filter((ws) => ws.deserializeAttachment()?.userId === userId).length >= 6
      )
        return new Response('Too many connections', {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      const response = await super.fetch(request)
      // Only shorten existing same-user grants; concurrent handshakes cannot extend one.
      for (const ws of this.chessState.getWebSockets()) {
        const attachment = ws.deserializeAttachment()
        if (attachment?.userId === userId)
          ws.serializeAttachment({
            ...attachment,
            chessExpires: Math.min(attachment.chessExpires ?? expires, expires),
          })
      }
      const expiries = this.chessState
        .getWebSockets()
        .map((ws) => ws.deserializeAttachment()?.chessExpires)
        .filter(Number.isFinite)
      if (expiries.length) await this.chessState.storage.setAlarm(Math.min(...expiries))
      return response
    }
    if (new URL(request.url).pathname === '/internal/chess-diagnostics') {
      if (
        request.headers.get('X-App-Action') !== 'true' ||
        !isDiagnosticsOwner(request.headers.get('X-User-Id'), this.chessEnv.OWNER_USER_ID)
      )
        return Response.json(
          { success: false, error: 'Only the app owner can view diagnostics.', status: 403 },
          { status: 403 },
        )
      return Response.json({
        success: true,
        data: {
          ...(await readTraces(this.chessState.storage)),
          usage: await readUsage(this.chessState.storage, this.chessEnv),
          credential: await aiCredentialStatus(this.chessEnv),
        },
      })
    }
    if (new URL(request.url).pathname !== '/internal/chess') return super.fetch(request)
    // This path is never routed from the public Worker. Only the authenticated
    // chess server action constructs this internal request.
    const userId = request.headers.get('X-User-Id')
    if (!userId || request.headers.get('X-App-Action') !== 'true')
      return new Response('Unauthorized', { status: 401 })
    const receivedTrace = request.headers.get('X-Chess-Trace')
    const traceId =
      receivedTrace && /^[a-f0-9-]{36}$/.test(receivedTrace) ? receivedTrace : crypto.randomUUID()
    const started = Date.now()
    const trace = createRequestTrace(traceId, started)
    const emit = trace.emit
    const persist = async () => {
      try {
        await saveTrace(this.chessState.storage, trace.record)
      } catch {
        traceEvent(traceId, 'telemetry.write_failed', {}, true)
      }
    }
    let operation = 'invalid'
    try {
      await admitRequest(this.chessState.storage, userId)
      const command = commandSchema.parse(await request.json())
      operation = command.op
      emit('operation.start', { operation })
      await persist()
      const data = await this.chessQueue.run(userId, async () => {
        emit('queue.ready', { operation, waitMs: Date.now() - started })
        const exec = async (tool: string, params: Record<string, unknown>, missing = false) => {
          const storeStarted = Date.now()
          const response = await super.fetch(
            new Request('https://internal/api/tools/execute', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-User-Id': userId,
                'X-App-Action': 'true',
              },
              body: JSON.stringify({ tool, params }),
            }),
          )
          const value = (await response.json()) as {
            success: boolean
            data?: { record?: Row<unknown>; records?: Row<unknown>[] }
            error?: string
          }
          emit('storage.complete', {
            tool,
            durationMs: Date.now() - storeStarted,
            success: value.success,
          })
          if (!value.success) {
            if (missing && value.error?.startsWith('Record not found')) return null
            throw new Error(value.error || 'Could not save your data.')
          }
          return value.data
        }
        const store: Store = {
          get: async <T>(collection: string, recordId: string) =>
            ((await exec('records.get', { collection, recordId }, true))
              ?.record as Row<T> | null) ?? null,
          put: async (collection, recordId, data) => {
            if (collection === 'games' && (command.op === 'create' || command.op === 'branch'))
              await admitCreation(this.chessState.storage, userId)
            await exec('records.create', { collection, recordId, data })
          },
          query: async <T>(collection: string, where: Record<string, unknown>, limit: number) =>
            ((
              await exec('records.query', {
                collection,
                where,
                limit,
                orderBy: 'createdAt',
                orderDir: 'desc',
              })
            )?.records as Row<T>[]) ?? [],
        }
        const provider = modelCall(this.chessEnv, traceId, emit)
        return executeChess(
          userId,
          command,
          store,
          async (...args) => {
            const release = await reserveModel(this.chessState.storage, userId, this.chessEnv)
            try {
              return await provider(...args)
            } finally {
              await release()
            }
          },
          emit,
        )
      })
      emit('operation.complete', { operation, durationMs: Date.now() - started })
      await persist()
      return Response.json({ success: true, data, traceId })
    } catch (error) {
      const code =
        error instanceof AiFailure || error instanceof ChessError
          ? error.code
          : error instanceof ZodError
            ? 'invalid_request'
            : 'internal_error'
      const status =
        error instanceof ChessError
          ? error.status
          : error instanceof AiFailure
            ? error.code === 'insufficient_credits'
              ? 402
              : error.code === 'rate_limited'
                ? 429
                : error.code === 'ai_timeout'
                  ? 504
                  : 503
            : error instanceof ZodError
              ? 400
              : 500
      emit('operation.failed', { operation, code, durationMs: Date.now() - started }, true)
      await persist()
      return Response.json(
        {
          success: false,
          error:
            error instanceof ChessError || error instanceof AiFailure
              ? error.message
              : error instanceof ZodError
                ? 'Invalid chess request.'
                : 'The request could not be completed. Please try again.',
          code,
          status,
          details: {
            traceId,
            ...(error instanceof ChessError && error.retryAfter
              ? { retryAfter: error.retryAfter }
              : {}),
          },
        },
        { status },
      )
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment()
    if (
      !attachment?.chessExpires ||
      attachment.chessExpires <= Date.now() ||
      (this.chessEnv.CHESS_BLOCKED_USER_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .includes(attachment.userId)
    ) {
      ws.close(1008, 'Session refresh required')
      return
    }
    const now = Date.now()
    const window =
      attachment.chessWindow?.start > now - 60_000
        ? attachment.chessWindow
        : { start: now, count: 0 }
    window.count++
    ws.serializeAttachment({ ...attachment, chessWindow: window })
    if (message === 'ping' && window.count <= 120) {
      ws.send('pong')
      return
    }
    const safe = safeSocketMessage(message)
    if (!safe || window.count > 120) {
      securityEvent(!safe ? 'socket_frame_denied' : 'socket_rate_limited', {
        route: 'realtime',
        status: 429,
      })
      ws.close(1008, 'Connection request limit exceeded')
      return
    }
    await super.webSocketMessage(ws, safe)
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string) {
    // The client controls the close reason; do not let it enter SDK logs.
    await super.webSocketClose(ws, code, '')
  }

  async alarm() {
    const remaining: number[] = []
    for (const ws of this.chessState.getWebSockets()) {
      const expires = ws.deserializeAttachment()?.chessExpires
      if (!expires || expires <= Date.now()) ws.close(1008, 'Session refresh required')
      else remaining.push(expires)
    }
    if (remaining.length) await this.chessState.storage.setAlarm(Math.min(...remaining))
  }
}

export class AppYjsRoom extends YjsRoom<Env> {}
export class AppCanvasRoom extends CanvasRoom<Env> {}
export class AppPresenceRoom extends PresenceRoom<Env> {}

/** Runs the scheduled tasks defined in src/cron.ts. */
export class AppCronRoom extends CronRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, { tasks: cronTasks })
  }

  protected async onTask(taskName: string): Promise<void> {
    await runCronTask(taskName, this.env)
  }
}

/** Runs durable background work defined in src/jobs.ts. */
export class AppJobRoom extends JobRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, {
      authorizeWrite: async (user) => {
        if (user.userId.startsWith('anon-')) return false
        const role = await resolveAppRole(env, user.userId)
        return role === 'member' || role === 'admin'
      },
    })
  }

  protected async onJob(job: Job, context: JobContext): Promise<unknown> {
    return await runJob(job, context, this.env)
  }
}

export interface Env extends DOBindings<typeof __DO_MANIFEST__> {
  CHESS_MODEL?: string
  CHESS_AI_ENABLED?: string
  CHESS_AI_USER_DAILY?: string
  CHESS_AI_APP_DAILY?: string
  CHESS_BLOCKED_USER_IDS?: string
  ASSETS: Fetcher
  /**
   * Platform service binding in production; deepspace dev supplies the URL
   * fallback. Standard app files use the platform's shared, app-scoped R2
   * bucket rather than a local binding.
   */
  PLATFORM_WORKER?: Fetcher
  PLATFORM_WORKER_URL?: string
  /**
   * HMAC app credential minted on first deploy. Proxy routes omit identity
   * headers when it is absent so upstream services fail closed.
   */
  APP_IDENTITY_TOKEN?: string
  /** API service binding in production with a deepspace-dev URL fallback. */
  API_WORKER?: Fetcher
  API_WORKER_URL?: string
  AUTH_JWT_PUBLIC_KEY: string
  AUTH_JWT_ISSUER: string
  AUTH_WORKER_URL: string
  /** Comma-separated exact Expo/native callback URIs (for example, myapp://auth/callback). */
  NATIVE_AUTH_REDIRECT_URIS?: string
  APP_NAME: string
  /** Immutable record-scope and platform identity. */
  DEEPSPACE_APP_ID: string
  OWNER_USER_ID: string
  /**
   * Long-lived owner JWT used for developer-billed server calls. User-billed
   * calls always forward the signed-in caller's JWT instead.
   */
  APP_OWNER_JWT: string
  /**
   * Enables /api/debug/* only when exactly "true". The route still requires
   * an authenticated app owner/admin. deepspace dev/test set it locally.
   */
  ALLOW_DEBUG_ROUTES?: string
}

export type AppContext = { Bindings: Env }

const app = new Hono<AppContext>()
registerSecurity(app)
// A Durable Object exists only once something fetches it, and the CronRoom
// arms its alarm in that first fetch — so wake it from the request path, or a
// deployed schedule waits for a visitor. Once per isolate; no-op without tasks.
app.use('*', async (c, next) => {
  armCronRoom(c.executionCtx, c.env.CRON_ROOMS, `app:${c.env.DEEPSPACE_APP_ID}`, cronTasks)
  await next()
})

// Registration order is part of the worker contract. The wildcard auth route
// follows its special cases, AI precedes platform proxies, and static is last.
registerAuthAndIntegrationRoutes(app)
registerRealtimeRoutes(app)
registerActionRoutes(app, resolveAuth)
// Every scaffold exposes selected tools through HTTP, MCP and browser tools.
// Only copilot owns the collections needed for the in-app chat UI.
registerAgent(app, {
  tools: buildTools,
  authorize: ({ userId, env }) => userId === env.OWNER_USER_ID,
  inApp: schemas.some((schema) => schema.name === AI_CHATS_SCHEMA.name),
})
registerPlatformProxyRoutes(app)
registerStaticRoutes(app)

export default app
