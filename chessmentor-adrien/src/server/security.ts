/**
 * HTTP security middleware installed first by worker.ts.
 * Hono handles routing and body-limit enforcement; this file defines the app policy.
 * Durable authenticated budgets live in src/chess/limits.ts, and WebSocket frame
 * validation lives in socket-security.ts. Static assets mirror headers in public/_headers.
 */

import type { Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppContext } from '../../worker'

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' wss://chessmentor-ai.app.space; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

export function securityEvent(
  event: string,
  fields: {
    requestId?: string
    route?: string
    status?: number
    code?: string
    durationMs?: number
    actor?: string
    traceId?: string
  } = {},
) {
  const line = JSON.stringify({
    event: 'security',
    ...fields,
    code: event,
    message: `security ${event}`,
  })

  if (event === 'action_result') console.info(line)
  else console.warn(line)
}

function routeCategory(path: string) {
  if (path.startsWith('/api/auth/')) return 'auth'
  if (path.startsWith('/api/actions/')) return 'action'
  if (path.startsWith('/ws/')) return 'realtime'
  if (path.startsWith('/api/')) return 'api'
  if (path.startsWith('/_deepspace/')) return 'agent'

  return 'page'
}

/** Cheap bounded per-isolate flood protection; durable authenticated limits are separate. */
export class BurstGuard {
  private windows = new Map<string, { start: number; count: number }>()
  allow(key: string, limit: number, now = Date.now()) {
    const existing = this.windows.get(key)

    if (existing && existing.start > now - 60_000) return ++existing.count <= limit
    if (this.windows.size >= 2048) {
      for (const [k, v] of this.windows) if (v.start <= now - 60_000) this.windows.delete(k)

      if (this.windows.size >= 2048) return false
    }

    this.windows.set(key, { start: now, count: 1 })

    return true
  }
}

export function registerSecurity(app: Hono<AppContext>) {
  const burst = new BurstGuard()
  app.use('*', async (c, next) => {
    const started = Date.now()
    const requestId = crypto.randomUUID()
    const path = new URL(c.req.url).pathname
    const route = routeCategory(path)
    c.header('X-Request-Id', requestId)
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Frame-Options', 'DENY')
    c.header('Content-Security-Policy', CSP)
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    c.header('Strict-Transport-Security', 'max-age=31536000')

    if (route !== 'page') c.header('Cache-Control', 'no-store')

    const origin = c.req.header('Origin')

    // Cross-origin scripts are not an API client. CLI callers without Origin still authenticate.
    if (route !== 'page' && origin && origin !== new URL(c.req.url).origin) {
      securityEvent('origin_denied', { requestId, route, status: 403 })

      return c.json(
        { success: false, error: 'Request origin is not allowed.', code: 'origin_denied' },
        403,
      )
    }
    if (route !== 'page') {
      const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'

      if (!burst.allow('all', 1200) || !burst.allow(ip, 120)) {
        c.header('Retry-After', '60')
        securityEvent('edge_burst_limited', { requestId, route, status: 429 })

        return c.json(
          { success: false, error: 'Too many requests. Please wait.', code: 'rate_limited' },
          429,
        )
      }
    }

    await next()

    if (c.res.status >= 400)
      securityEvent('request_rejected', {
        requestId,
        route,
        status: c.res.status,
        durationMs: Date.now() - started,
      })
  })
  const limit = bodyLimit({
    maxSize: 16_384,
    onError: (c) =>
      c.json({ success: false, error: 'Request body is too large.', code: 'body_too_large' }, 413),
  })
  const boundedBody: MiddlewareHandler<AppContext> = async (c, next) => {
    // Count actual bytes even when a proxy supplies an incorrect Content-Length.
    if (c.req.raw.body) {
      const headers = new Headers(c.req.raw.headers)
      headers.delete('Content-Length')
      c.req.raw = new Request(c.req.raw, { headers })
    }

    return limit(c, next)
  }
  app.use('/api/*', boundedBody)
  // ChessMentor has no generic provider UI, uploads, payments, native app or debug console.
  app.use('/_deepspace/*', boundedBody)
  app.use('/_deepspace/*', async (c, next) => {
    const path = new URL(c.req.url).pathname

    if (path === '/_deepspace/agent' || path.startsWith('/_deepspace/agent/')) return next()

    return c.json({ error: 'Not found' }, 404)
  })

  for (const route of [
    '/api/files',
    '/api/files/*',
    '/api/debug/*',
    '/api/auth/native-start',
    '/api/auth/native-exchange',
    '/api/auth/native-token',
    '/api/auth/native-me',
    '/api/auth/native-signout',
  ])
    app.all(route, (c) => c.json({ error: 'Not found' }, 404))

  app.all('/api/integrations/*', (c) =>
    c.json(
      { success: false, error: 'Use the chess mentor or opponent.', code: 'integration_disabled' },
      403,
    ),
  )
  app.onError((_error, c) => {
    securityEvent('unexpected_error', {
      requestId: c.res.headers.get('X-Request-Id') ?? undefined,
      route: routeCategory(new URL(c.req.url).pathname),
      status: 500,
    })

    return c.json(
      {
        success: false,
        error: 'The request could not be completed. Please try again.',
        code: 'internal_error',
      },
      500,
    )
  })
}
