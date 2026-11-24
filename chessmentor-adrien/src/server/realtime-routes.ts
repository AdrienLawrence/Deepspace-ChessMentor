import type { Hono } from 'hono'
import { authenticatedRoomRequest } from 'deepspace/worker'
import type { AppContext } from '../../worker'
import { verifyUserToken } from './auth'

/** Only the authenticated app RecordRoom is used by ChessMentor. */
export function registerRealtimeRoutes(app: Hono<AppContext>): void {
  app.get('/ws/:roomId', async (c) => {
    if (c.req.param('roomId') !== `app:${c.env.DEEPSPACE_APP_ID}`)
      return c.json({ error: 'Not found' }, 404)
    const auth = await verifyUserToken(c.env, new URL(c.req.url).searchParams.get('token'))
    if (!auth) return c.json({ error: 'Unauthorized' }, 401)
    const request = authenticatedRoomRequest(c.req.raw, auth)
    for (const header of ['X-App-Action', 'X-App-Identity-Token', 'X-App-Id', 'X-Chess-Trace'])
      request.headers.delete(header)
    request.headers.set('X-Chess-Session-Expires', String(auth.claims.exp))
    const stub = c.env.RECORD_ROOMS.get(
      c.env.RECORD_ROOMS.idFromName(`app:${c.env.DEEPSPACE_APP_ID}`),
    )
    return stub.fetch(request)
  })
  app.all('/ws/*', (c) => c.json({ error: 'Not found' }, 404))
}
