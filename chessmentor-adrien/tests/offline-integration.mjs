/** Offline integration harness: real compiled Worker + SQLite RecordRoom + browser.
 * Auth and OpenAI are explicit local test doubles, never production fallbacks.
 * No real credentials, remote accounts, or billable inference are used.
 */
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const appId = /DEEPSPACE_APP_ID = "([^"]+)"/.exec(
  await readFile(resolve(root, 'wrangler.toml'), 'utf8'),
)[1]
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const issuer = 'https://chessmentor-test.invalid'
function token(userId) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(
    JSON.stringify({
      sub: userId,
      iss: issuer,
      exp: Math.floor(Date.now() / 1000) + 3600,
      name: userId === 'alice' ? 'Alice Learner' : 'Bob Learner',
      email: `${userId}@example.test`,
    }),
  ).toString('base64url')
  return `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}
const tokens = { alice: token('alice'), bob: token('bob') }
const calls = []
let providerFailure = false
const assets = resolve(root, 'dist/client')
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
}
async function serveAsset(req) {
  const path = decodeURIComponent(new URL(req.url).pathname)
  const file = resolve(assets, '.' + (path === '/' ? '/index.html' : path))
  if (!file.startsWith(assets + sep)) return new Response('Not found', { status: 404 })
  try {
    return new Response(await readFile(file), {
      headers: { 'Content-Type': mime[extname(file)] || 'application/octet-stream' },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
async function authDouble(req) {
  const path = new URL(req.url).pathname
  const user = /test-user=(alice|bob)/.exec(req.headers.get('cookie') || '')?.[1]
  if (path === '/api/auth/ok') return Response.json({ ok: true })
  if (path === '/api/auth/token')
    return user
      ? Response.json({ token: tokens[user] })
      : Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (path === '/api/auth/get-session')
    return Response.json(
      user
        ? {
            user: {
              id: user,
              name: user === 'alice' ? 'Alice Learner' : 'Bob Learner',
              email: `${user}@example.test`,
              emailVerified: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            session: {
              id: `session-${user}`,
              userId: user,
              token: 'local-test-only',
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }
        : null,
    )
  return Response.json({ error: 'External traffic disabled in offline tests' }, { status: 503 })
}
const mf = new Miniflare(
  convertV4MiniflareOptions({
    host: '127.0.0.1',
    port: 5197,
    workers: [
      {
        name: 'chess-test',
        modules: true,
        scriptPath: resolve(root, 'dist/chessmentor_ai/index.js'),
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          DEEPSPACE_APP_ID: appId,
          APP_NAME: 'ChessMentor',
          OWNER_USER_ID: 'alice',
          AUTH_JWT_PUBLIC_KEY: publicKey.export({ format: 'pem', type: 'spki' }),
          AUTH_JWT_ISSUER: issuer,
          AUTH_WORKER_URL: issuer,
          APP_OWNER_JWT: 'test-owner-billing-token',
          ALLOW_DEBUG_ROUTES: 'false',
        },
        durableObjects: Object.fromEntries(
          [
            ['RECORD_ROOMS', 'AppRecordRoom'],
            ['YJS_ROOMS', 'AppYjsRoom'],
            ['CANVAS_ROOMS', 'AppCanvasRoom'],
            ['PRESENCE_ROOMS', 'AppPresenceRoom'],
            ['CRON_ROOMS', 'AppCronRoom'],
            ['JOB_ROOMS', 'AppJobRoom'],
          ].map(([binding, className]) => [binding, { className, useSQLite: true }]),
        ),
        outboundService: authDouble,
        serviceBindings: {
          ASSETS: serveAsset,
          API_WORKER: async (req) => {
            assert.equal(
              req.headers.get('x-auth-token'),
              'test-owner-billing-token',
              'Inference must bill the developer',
            )
            const body = await req.json()
            const context = JSON.parse(body.messages.find((m) => m.role === 'user').content)
            calls.push(context)
            if (providerFailure)
              return Response.json(
                { error: { message: 'Offline fixture provider failure', type: 'server_error' } },
                { status: 503 },
              )
            const opponent = body.messages[0].content.includes('chess opponent')
            const content = opponent
              ? {
                  uci:
                    context.legalMoves.find((m) => m.uci === 'e7e5' || m.uci === 'e2e4')?.uci ||
                    context.legalMoves[0].uci,
                }
              : {
                  content: `At ply ${context.ply}, consider how the central squares connect your pieces. Look at the highlighted square and ask which pieces can support it.`,
                  annotations: [
                    { type: 'highlight', square: 'e4', tone: 'yellow', label: 'Central focus' },
                    {
                      type: 'arrow',
                      from: 'g1',
                      to: 'f3',
                      tone: 'green',
                      label: 'A connection to explore',
                    },
                  ],
                }
            return Response.json({
              id: 'test-completion',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: JSON.stringify(content) },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
            })
          },
        },
      },
    ],
  }),
)
let browser
let checks = 0
async function check(name, fn) {
  await fn()
  checks++
  console.log(`PASS ${name}`)
}
try {
  const base = (await mf.ready).origin
  const room = await mf.getDurableObjectNamespace('RECORD_ROOMS')
  const stub = room.get(room.idFromName(`app:${appId}`))
  async function tool(user, name, params, privileged = false) {
    const r = await stub.fetch('https://internal/api/tools/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': user,
        ...(privileged ? { 'X-App-Action': 'true' } : {}),
      },
      body: JSON.stringify({ tool: name, params }),
    })
    return r.json()
  }
  async function action(user, params) {
    const r = await fetch(`${base}/api/actions/chess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[user]}` },
      body: JSON.stringify(params),
    })
    return r.json()
  }
  // Seed user membership through the same supported internal operation used on connection.
  for (const user of ['alice', 'bob'])
    await tool(
      user,
      'users.register',
      { userId: user, name: `${user} learner`, email: `${user}@example.test` },
      true,
    )
  let id
  const getGame = async () =>
    (await tool('alice', 'records.get', { collection: 'games', recordId: id }, true)).data.record
      .data
  await check('compiled Worker creates and round-trips JSON/boolean records', async () => {
    const r = await action('alice', {
      op: 'create',
      color: 'w',
      automaticFeedback: true,
      requestId: crypto.randomUUID(),
    })
    assert.equal(r.success, true, JSON.stringify(r))
    id = r.data.gameId
    const game = await getGame()
    assert.equal(game.automaticFeedback, true)
    assert.deepEqual(game.moveHistory, [])
  })
  await check('public route rejects missing and forged identities', async () => {
    assert.equal(
      (
        await fetch(`${base}/api/actions/chess`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': 'alice',
            'X-App-Action': 'true',
          },
          body: JSON.stringify({ op: 'resign', gameId: id, version: 0 }),
        })
      ).status,
      401,
    )
    assert.equal(
      (
        await fetch(`${base}/internal/chess`, {
          method: 'POST',
          headers: { 'X-User-Id': 'alice', 'X-App-Action': 'true' },
          body: '{}',
        })
      ).status,
      404,
    )
  })
  await check('two real Worker requests cannot commit the same revision', async () => {
    const results = await Promise.all(
      ['e2e4', 'd2d4'].map((uci) => action('alice', { op: 'move', gameId: id, version: 0, uci })),
    )
    assert.equal(results.filter((r) => r.success).length, 1)
    assert.equal((await getGame()).version, 1)
  })
  await check('OpenAI proxy adapter validates and persists one opponent move', async () => {
    const before = calls.length
    const results = await Promise.all(
      [1, 2].map(() => action('alice', { op: 'opponent', gameId: id, version: 1 })),
    )
    assert.ok(
      results.every((r) => r.success),
      JSON.stringify(results),
    )
    assert.equal(calls.length, before + 1)
    assert.equal((await getGame()).version, 2)
  })
  await check('SDK read and write APIs enforce ownership and immutability', async () => {
    assert.equal(
      (await tool('bob', 'records.get', { collection: 'games', recordId: id })).success,
      false,
    )
    for (const user of ['alice', 'bob'])
      assert.equal(
        (
          await tool(user, 'records.update', {
            collection: 'games',
            recordId: id,
            data: { currentFen: 'forged' },
          })
        ).success,
        false,
      )
    assert.equal((await action('bob', { op: 'resign', gameId: id, version: 2 })).success, false)
  })
  await check('saved historical coaching is idempotent and uses exact FEN', async () => {
    const game = await getGame(),
      request = {
        op: 'ask',
        gameId: id,
        ply: 0,
        fen: game.moveHistory[0].before,
        question: 'What matters in the starting position?',
        requestId: crypto.randomUUID(),
      }
    const before = calls.length
    assert.equal((await action('alice', request)).success, true)
    assert.equal((await action('alice', request)).success, true)
    assert.equal(calls.length, before + 1)
    assert.equal(calls.at(-1).fen, request.fen)
    const messages = await tool('alice', 'records.query', {
      collection: 'game_messages',
      where: { gameId: id },
    })
    assert.equal(messages.data.records.length, 2)
  })
  await check(
    'feedback cache avoids inference and provider failures remain recoverable',
    async () => {
      const before = calls.length
      for (let n = 0; n < 2; n++)
        assert.equal((await action('alice', { op: 'feedback', gameId: id, ply: 1 })).success, true)
      assert.equal(calls.length, before + 1)
      const r = await action('bob', {
        op: 'create',
        color: 'b',
        automaticFeedback: false,
        requestId: crypto.randomUUID(),
      })
      providerFailure = true
      assert.equal(
        (await action('bob', { op: 'opponent', gameId: r.data.gameId, version: 0 })).success,
        false,
      )
      providerFailure = false
      assert.equal(
        (await action('bob', { op: 'opponent', gameId: r.data.gameId, version: 0 })).success,
        true,
      )
    },
  )
  await check('browser cannot access developer-funded raw OpenAI endpoint', async () => {
    assert.equal(
      (
        await fetch(`${base}/api/integrations/openai/chat-completion`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.alice}` },
        })
      ).status,
      403,
    )
  })
  browser = await chromium.launch({
    channel:
      process.env.CHESS_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } })
  await context.addCookies([{ name: 'test-user', value: 'alice', url: base }])
  const page = await context.newPage(),
    errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mkdir(resolve(root, 'test-results/screenshots'), { recursive: true })
  await check('dashboard and setup render with the real reactive record connection', async () => {
    await page.goto(`${base}/home`)
    await page.getByRole('heading', { name: 'My games', exact: true }).waitFor()
    await page.getByText('Resume game', { exact: true }).first().waitFor()
    await page.screenshot({
      path: resolve(root, 'test-results/screenshots/dashboard.png'),
      fullPage: true,
    })
    await page.goto(`${base}/game/new`)
    await page.getByRole('button', { name: 'White Make the first move' }).waitFor()
    await page.screenshot({
      path: resolve(root, 'test-results/screenshots/new-game.png'),
      fullPage: true,
    })
    await page.getByRole('button', { name: 'Start learning', exact: true }).click()
    await page.waitForURL(/\/game\/game-/)
    await page.getByRole('heading', { name: 'Make your next move count.' }).waitFor()
  })
  let browserGameUrl
  await check(
    'click-to-move, opponent response, question, and follow-up work together',
    async () => {
      browserGameUrl = page.url()
      await page.getByRole('button', { name: 'e2 White pawn', exact: true }).click()
      await page.getByRole('button', { name: 'e4 empty, legal destination', exact: true }).click()
      await page.getByRole('button', { name: 'View ply 2: e5', exact: true }).waitFor()
      await page.getByLabel('Ask about the selected position').fill('What should I notice?')
      await page.getByRole('button', { name: 'Send question', exact: true }).click()
      await page.getByText('Show 2 board annotations', { exact: true }).waitFor()
      await page.getByLabel('Ask about the selected position').fill('Which pieces can help?')
      await page.getByRole('button', { name: 'Send question', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.message.coach .text-button').length === 2,
      )
      await page.getByText('Show 2 board annotations', { exact: true }).last().click()
      await page.screenshot({
        path: resolve(root, 'test-results/screenshots/live-game.png'),
        fullPage: true,
      })
    },
  )
  await check('refresh restores game, messages and board annotations', async () => {
    await page.reload()
    await page.getByText('Show 2 board annotations', { exact: true }).last().waitFor()
    await page.getByText('Show 2 board annotations', { exact: true }).last().click()
    assert.equal(await page.locator('.annotation-overlay line').count(), 1)
    assert.equal(await page.locator('.annotation-overlay rect').count(), 1)
  })
  await check(
    'historical navigation never triggers inference and questions use selected ply',
    async () => {
      const before = calls.length
      await page.getByRole('link', { name: 'Analyze', exact: true }).click()
      await page.getByRole('button', { name: 'Starting position', exact: true }).click()
      await page.waitForTimeout(250)
      assert.equal(calls.length, before)
      await page
        .getByLabel('Ask about the selected position')
        .fill('What was the plan before the first move?')
      await page.getByRole('button', { name: 'Send question', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.message.coach .text-button').length === 3,
      )
      assert.equal(calls.at(-1).ply, 0)
      await page.reload()
      await page.getByText('What was the plan before the first move?', { exact: true }).waitFor()
      await page.screenshot({
        path: resolve(root, 'test-results/screenshots/analysis.png'),
        fullPage: true,
      })
    },
  )
  await check('mobile workspace fits the viewport and chat remains usable', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(browserGameUrl)
    await page.getByRole('heading', { name: 'Your chess mentor' }).waitFor()
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'No horizontal overflow',
    )
    const board = await page.locator('.chessboard').boundingBox()
    assert.ok(board.width >= 340 && board.width <= 390)
    await page.screenshot({
      path: resolve(root, 'test-results/screenshots/mobile.png'),
      fullPage: true,
    })
  })
  await check(
    'resignation persists and the dashboard opens completed games in analysis',
    async () => {
      await page.getByRole('button', { name: 'Resign game', exact: true }).click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Resign game', exact: true })
        .click()
      await page.getByRole('heading', { name: 'A game to learn from', exact: true }).waitFor()
      await page.goto(`${base}/home`)
      await page.getByText('Analyze game', { exact: true }).first().click()
      await page.getByRole('heading', { name: 'Every move, a lesson.' }).waitFor()
      assert.deepEqual(errors, [], 'No uncaught browser errors')
    },
  )
  await check('signed-out landing renders and protected game routes require sign-in', async () => {
    const guest = await browser.newContext(),
      p = await guest.newPage()
    await p.goto(base)
    await p.getByRole('heading', { name: /Don’t just make a move/ }).waitFor()
    await p.screenshot({
      path: resolve(root, 'test-results/screenshots/landing.png'),
      fullPage: true,
    })
    await p.goto(browserGameUrl)
    await p.getByRole('heading', { name: 'Sign in to continue' }).waitFor()
    await guest.close()
  })
  console.log(
    `\n${checks} offline integration checks passed. Auth and OpenAI were mocked; Worker, SQLite records, permissions, WebSockets and browser UI were real.`,
  )
} finally {
  await browser?.close()
  await mf.dispose()
}
