/** Browser integration with explicit in-memory persistence/auth/provider doubles.
 * The production React bundle and application service are real. This does not
 * validate the Cloudflare runtime; use offline-integration.mjs for that layer.
 */
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
const root = resolve(import.meta.dirname, '..')
const runtime = resolve(root, 'test-results/browser-runtime')
await mkdir(runtime, { recursive: true })
for (const name of [
  'types',
  'errors',
  'rules',
  'diagnostics',
  'telemetry',
  'ai',
  'conversation',
  'service',
]) {
  const source = await readFile(resolve(root, `src/chess/${name}.ts`), 'utf8')
  const output = ts
    .transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace(/from '(\.\/[a-z-]+)'/g, "from '$1.mjs'")
  await writeFile(resolve(runtime, `${name}.mjs`), output)
}
const { executeChess, SerialQueue } = await import(pathToFileURL(resolve(runtime, 'service.mjs')))
const { createRequestTrace, saveTrace, readTraces } = await import(
  pathToFileURL(resolve(runtime, 'telemetry.mjs'))
)
const traceRows = new Map()
const traceStore = {
  async put(key, value) {
    traceRows.set(key, structuredClone(value))
  },
  async list(options) {
    let entries = [...traceRows]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b))
    if (options.reverse) entries.reverse()
    return new Map(entries.slice(0, options.limit ?? entries.length))
  },
  async delete(keys) {
    keys.forEach((key) => traceRows.delete(key))
    return keys.length
  },
}
let modelFailure = false
let modelDelay = 100
let modelError = null
let moveDelay = 0
let rejectMove = false
let actionCount = 0
const queue = new SerialQueue(),
  rows = new Map(),
  sockets = new Set(),
  calls = []
const currentUser = (cookie) => /test-user=(alice|bob)/.exec(cookie || '')?.[1]
const userInfo = (user) => ({
  id: user,
  name: user === 'alice' ? 'Alice Learner' : 'Bob Learner',
  email: `${user}@example.test`,
  role: 'member',
})
function query(collection, where = {}, user = 'alice', direction = 'asc') {
  return [...rows.values()]
    .filter(
      (r) =>
        r.collection === collection &&
        r.data.playerId === user &&
        Object.entries(where).every(([k, v]) => (k === 'recordId' ? r.recordId : r.data[k]) === v),
    )
    .sort((a, b) =>
      direction === 'desc'
        ? b.updatedAt.localeCompare(a.updatedAt)
        : a.createdAt.localeCompare(b.createdAt),
    )
}
function refreshSubscribers() {
  for (const entry of sockets) {
    for (const [subscriptionId, q] of entry.subscriptions)
      entry.socket.send(
        JSON.stringify({
          type: 'core.query_result',
          payload: {
            subscriptionId,
            records: query(q.collection, q.where, entry.user, q.orderDir),
          },
        }),
      )
  }
}
const store = {
  async get(c, id) {
    return structuredClone(rows.get(c + id) || null)
  },
  async put(c, id, data) {
    const old = rows.get(c + id)
    rows.set(c + id, {
      collection: c,
      recordId: id,
      data: structuredClone(data),
      createdBy: data.playerId,
      createdAt: old?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    refreshSubscribers()
  },
  async query(c, where, limit) {
    return structuredClone(query(c, where).reverse().slice(0, limit))
  },
}
async function model(system, context) {
  calls.push(context)
  if (modelFailure) throw new Error('Test provider unavailable')
  await new Promise((r) => setTimeout(r, modelDelay))
  if (modelError) throw modelError
  if (system.includes('chess opponent'))
    return {
      uci:
        context.legalMoves.find((m) => ['e7e5', 'e2e4'].includes(m.uci))?.uci ||
        context.legalMoves[0].uci,
    }
  return {
    content: `At ply ${context.ply}, consider how the central squares connect your pieces. Look at the highlighted square and ask which pieces can support it.`,
    annotations: [
      { type: 'highlight', square: 'e4', tone: 'yellow', label: 'Central focus' },
      { type: 'arrow', from: 'g1', to: 'f3', tone: 'green', label: 'A connection to explore' },
    ],
  }
}
const seed = await executeChess(
  'alice',
  { op: 'create', requestId: crypto.randomUUID(), color: 'w', automaticFeedback: false },
  store,
  model,
)
const assets = resolve(root, 'dist/client')
const securityHeaders = Object.fromEntries(
  (await readFile(resolve(root, 'public/_headers'), 'utf8'))
    .split(/\r?\n/)
    .filter((line) => /^  [A-Za-z-]+:/.test(line))
    .map((line) => {
      const colon = line.indexOf(':')
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
    }),
)
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1'),
      user = currentUser(req.headers.cookie)
    const json = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/api/auth/get-session')
      return json(
        user
          ? {
              user: {
                ...userInfo(user),
                emailVerified: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              session: {
                id: `session-${user}`,
                userId: user,
                token: 'local-test',
                expiresAt: new Date(Date.now() + 3600000).toISOString(),
              },
            }
          : null,
      )
    if (url.pathname === '/api/auth/token')
      return user
        ? json({
            token: `fixture.${Buffer.from(JSON.stringify({ sub: user, name: userInfo(user).name, email: userInfo(user).email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`,
          })
        : json({ error: 'Unauthorized' }, 401)
    if (url.pathname === '/api/actions/diagnostics') {
      if (!user) return json({ success: false, error: 'Unauthorized' }, 401)
      if (user !== 'alice')
        return json(
          { success: false, error: 'Only the app owner can view diagnostics.', status: 403 },
          403,
        )
      return json({ success: true, data: await readTraces(traceStore) })
    }
    if (url.pathname === '/api/actions/chess') {
      actionCount++
      if (!user) return json({ success: false, error: 'Unauthorized' }, 401)
      let body = ''
      for await (const chunk of req) body += chunk
      const trace = createRequestTrace(crypto.randomUUID())
      trace.emit('operation.start', { operation: JSON.parse(body).op })
      try {
        if (JSON.parse(body).op === 'move') {
          await new Promise((r) => setTimeout(r, moveDelay))
          if (rejectMove) throw new Error('Test move save rejected')
        }
        const tracedModel = async (...args) => {
          const started = Date.now()
          trace.emit('model.start', { purpose: args[2] ?? 'mentor', model: 'test-fixture' })
          try {
            const result = await model(...args)
            trace.emit('model.complete', {
              durationMs: Date.now() - started,
              inputTokens: 100,
              outputTokens: 25,
            })
            return result
          } catch (e) {
            trace.emit(
              'model.failed',
              { durationMs: Date.now() - started, code: e.code ?? 'test_failure' },
              true,
            )
            throw e
          }
        }
        const data = await queue.run(user, () =>
          executeChess(user, JSON.parse(body), store, tracedModel, trace.emit),
        )
        trace.emit('operation.complete')
        await saveTrace(traceStore, trace.record)
        return json({ success: true, data })
      } catch (e) {
        trace.emit('operation.failed', { code: e.code ?? 'test_failure' }, true)
        await saveTrace(traceStore, trace.record)
        return json({ success: false, error: e.message })
      }
    }
    if (url.pathname.startsWith('/api/'))
      return json({ success: false, error: 'No remote services in browser fixtures' }, 404)
    let file = resolve(
      assets,
      '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)),
    )
    if (!file.startsWith(assets + sep)) return json({}, 404)
    let content
    try {
      content = await readFile(file)
    } catch {
      file = resolve(assets, '_spa.html')
      content = await readFile(file)
    }
    res.writeHead(200, {
      ...securityHeaders,
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
    })
    res.end(content)
  } catch (e) {
    res.writeHead(500)
    res.end(e.message)
  }
})
await new Promise((r) => server.listen(5198, '127.0.0.1', r))
const base = 'http://127.0.0.1:5198'
let browser,
  checks = 0
async function check(name, fn) {
  await fn()
  checks++
  console.log(`PASS ${name}`)
}
try {
  browser = await chromium.launch({
    channel:
      process.env.CHESS_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } })
  await context.addCookies([{ name: 'test-user', value: 'alice', url: base }])
  await context.routeWebSocket('**/ws/**', (socket) => {
    const entry = { socket, user: 'alice', subscriptions: new Map() }
    sockets.add(entry)
    socket.onClose(() => sockets.delete(entry))
    socket.onMessage((raw) => {
      if (String(raw) === 'ping') {
        socket.send('pong')
        return
      }
      const message = JSON.parse(String(raw))
      if (message.type === 'core.subscribe') {
        const { subscriptionId, query: q } = message.payload
        entry.subscriptions.set(subscriptionId, q)
        refreshSubscribers()
      }
      if (message.type === 'core.unsubscribe')
        entry.subscriptions.delete(message.payload.subscriptionId)
    })
    socket.send(JSON.stringify({ type: 'user.info', payload: userInfo('alice') }))
    socket.send(JSON.stringify({ type: 'user.list', payload: { users: [userInfo('alice')] } }))
  })
  const page = await context.newPage(),
    errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mkdir(resolve(root, 'test-results/screenshots'), { recursive: true })
  await check('dashboard and setup render with the mocked reactive record connection', async () => {
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
    'optimistic move appears before persistence and rolls back on failure without inference',
    async () => {
      const id = page.url().split('/').at(-1)
      const before = calls.length
      moveDelay = 1800
      rejectMove = true
      await page.getByRole('button', { name: 'e2 White pawn', exact: true }).click()
      await page.getByRole('button', { name: 'e4 empty, legal destination', exact: true }).click()
      await page
        .getByRole('button', { name: 'e4 White pawn', exact: true })
        .waitFor({ timeout: 700 })
      assert.equal((await store.get('games', id)).data.version, 0)
      assert.equal(calls.length, before)
      assert.equal(
        await page.getByRole('button', { name: 'e4 White pawn', exact: true }).isDisabled(),
        true,
      )
      await page.getByText('Test move save rejected', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'e2 White pawn', exact: true }).waitFor()
      assert.equal((await store.get('games', id)).data.version, 0)
      assert.equal(calls.length, before)
      await page.getByRole('button', { name: 'Dismiss error', exact: true }).click()
      rejectMove = false
    },
  )
  await check(
    'click-to-move, opponent response, question, and follow-up work together',
    async () => {
      browserGameUrl = page.url()
      const id = page.url().split('/').at(-1)
      const before = calls.length
      modelDelay = 12000
      await page.getByRole('button', { name: 'e2 White pawn', exact: true }).click()
      await page.getByRole('button', { name: 'e4 empty, legal destination', exact: true }).click()
      await page
        .getByRole('button', { name: 'e4 White pawn', exact: true })
        .waitFor({ timeout: 700 })
      assert.equal((await store.get('games', id)).data.version, 0)
      assert.equal(calls.length, before, 'No AI before the optimistic move is committed')
      await page
        .getByText(
          'The opponent is taking a little longer. You can review earlier moves while you wait.',
          { exact: true },
        )
        .waitFor({ timeout: 15000 })
      assert.match(await page.locator('.thinking-pill').innerText(), /\d+s/)
      await page.getByRole('button', { name: 'View ply 2: e5', exact: true }).waitFor()
      moveDelay = 0
      modelDelay = 100
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
    assert.equal(
      await page.locator('[data-square="a2"] .chess-piece > g').getAttribute('fill'),
      '#fff9ec',
    )
    assert.equal(
      await page.locator('[data-square="a7"] .chess-piece > g').getAttribute('fill'),
      '#242622',
    )
    assert.equal(await page.locator('.chessboard svg[data-piece="p"][data-color="w"]').count(), 8)
    assert.equal(await page.locator('.chessboard svg[data-piece="p"][data-color="b"]').count(), 8)
    assert.doesNotMatch(await page.locator('.chessboard').textContent(), /[♟♞♜♝♛♚]/)
    await page.screenshot({
      path: resolve(root, 'test-results/screenshots/mobile.png'),
      fullPage: true,
    })
  })
  await check('laptop layout has a large board, visible composer and reachable navigation', async () => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto(browserGameUrl)
    await page.getByLabel('Ask about the selected position').waitFor()
    const board = await page.locator('.board-section .chessboard').boundingBox()
    const composer = await page.getByLabel('Ask about the selected position').boundingBox()
    assert.ok(
      board.width >= 500 && board.width <= 560,
      'Laptop board balances readable squares and screen space',
    )
    assert.ok(Math.abs(board.width - board.height) < 1, 'Board remains square')
    assert.ok(composer.y + composer.height <= 768, 'Composer fits laptop height')
    assert.match(await page.getByLabel('Material count').innerText(), /White 39 · Black 39/)
    await page.screenshot({
      path: resolve(root, 'test-results/screenshots/large-laptop.png'),
      fullPage: true,
    })
    await page.locator('.move-navigation').scrollIntoViewIfNeeded()
    const navigation = await page.locator('.move-navigation').boundingBox()
    assert.ok(
      navigation.y >= 0 && navigation.y + navigation.height <= 768,
      'Move navigation remains reachable by scrolling',
    )
  })
  await check(
    'traversing to the latest move restores live interaction and annotations clear without deleting messages',
    async () => {
      await page.setViewportSize({ width: 1440, height: 1080 })
      await page.goto(browserGameUrl)
      await page.getByRole('button', { name: 'Previous move', exact: true }).click()
      await page.getByRole('button', { name: 'Next move', exact: true }).click()
      await page.getByRole('button', { name: 'Live position', exact: true }).waitFor()
      await page.getByRole('button', { name: 'g1 White knight', exact: true }).click()
      await page.getByRole('button', { name: 'f3 empty, legal destination', exact: true }).waitFor()
      await page.getByRole('button', { name: 'g1 White knight', exact: true }).click()
      await page.getByText('Show 2 board annotations', { exact: true }).last().click()
      const count = await page.locator('.message').count()
      await page.getByRole('button', { name: 'Clear annotations', exact: true }).click()
      assert.equal(await page.locator('.annotation-overlay line').count(), 0)
      assert.equal(await page.locator('.message').count(), count)
      await page.getByRole('button', { name: 'View response at ply 0', exact: true }).click()
      await page.getByRole('button', { name: 'Return to Live', exact: true }).waitFor()
    },
  )
  await check(
    'submission clears and locks input, blocks duplicates, and scrolls completed responses into view',
    async () => {
      await page.getByRole('button', { name: 'Return to Live', exact: true }).click()
      modelDelay = 1800
      const before = actionCount
      await page.getByLabel('Ask about the selected position').fill('Pending response regression')
      await page.getByRole('button', { name: 'Send question', exact: true }).click()
      assert.equal(await page.getByLabel('Ask about the selected position').inputValue(), '')
      assert.equal(await page.getByLabel('Ask about the selected position').isDisabled(), true)
      assert.equal(
        await page.getByRole('button', { name: 'Send question', exact: true }).isDisabled(),
        true,
      )
      await page.getByText('Waiting for your mentor…', { exact: true }).waitFor()
      await page.locator('.messages').evaluate((el) => {
        el.scrollTop = 0
      })
      await page.waitForFunction(() => !document.querySelector('#mentor-question').disabled)
      await page.waitForFunction(() => {
        const el = document.querySelector('.messages')
        return el.scrollHeight - el.clientHeight - el.scrollTop < 4
      })
      assert.equal(actionCount, before + 1)
      modelDelay = 100
    },
  )
  await check(
    'credit errors preserve the question and retry its original position without duplicates',
    async () => {
      const { AiFailure } = await import(pathToFileURL(resolve(runtime, 'diagnostics.mjs')))
      modelError = new AiFailure('insufficient_credits', 402)
      modelDelay = 800
      await page.getByLabel('Ask about the selected position').fill('Credit error regression')
      await page.getByRole('button', { name: 'Send question', exact: true }).click()
      await page.getByRole('button', { name: 'Starting position', exact: true }).click()
      await page.waitForFunction(() => !document.querySelector('#mentor-question').disabled)
      assert.equal(
        await page.getByLabel('Ask about the selected position').inputValue(),
        'Credit error regression',
      )
      await page
        .getByText(/credit balance cannot cover/)
        .first()
        .waitFor()
      modelError = null
      modelDelay = 100
      await page.getByRole('button', { name: 'Send question', exact: true }).click()
      await page.waitForFunction(() => !document.querySelector('#mentor-question').disabled)
      assert.equal(calls.at(-1).ply, 2)
      assert.equal(await page.getByText('Credit error regression', { exact: true }).count(), 1)
    },
  )
  await check(
    'all saved reflections stay visible across positions and selecting one navigates its board',
    async () => {
      const gameId = browserGameUrl.split('/').at(-1)
      const saved = (await store.get('games', gameId)).data
      for (const ply of [1, 2])
        await store.put('move_feedback', `${gameId}-feedback-${ply}`, {
          playerId: 'alice',
          gameId,
          ply,
          positionFen: saved.moveHistory[ply - 1].after,
          summary: `Saved reflection ${ply}`,
          annotations: [],
        })
      await page.getByText('Saved reflection 1', { exact: true }).waitFor()
      await page.getByText('Saved reflection 2', { exact: true }).waitFor()
      await page.getByText('Saved reflection 1', { exact: true }).click()
      await page.getByText('Ply 1 of 2', { exact: true }).waitFor()
      assert.equal(await page.locator('.message.feedback').count(), 2)
    },
  )
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
  await check('Black orientation, automatic opening and saved automatic feedback', async () => {
    await page.setViewportSize({ width: 1440, height: 1080 })
    await page.goto(`${base}/game/new`)
    await page.getByRole('button', { name: 'Black Let the opponent begin' }).click()
    await page.getByRole('switch').check()
    await page.getByRole('button', { name: 'Start learning', exact: true }).click()
    await page.getByRole('button', { name: 'View ply 1: e4', exact: true }).waitFor()
    assert.equal(
      await page.locator('.chessboard [data-square]').first().getAttribute('data-square'),
      'h1',
    )
    await page.getByText('MOVE REFLECTION · PLY 1', { exact: false }).waitFor()
    assert.equal(
      await page.locator('[data-square="a7"] .chess-piece > g').getAttribute('fill'),
      '#242622',
    )
    assert.equal(
      await page.locator('[data-square="a2"] .chess-piece > g').getAttribute('fill'),
      '#fff9ec',
    )
    await page.screenshot({
      path: resolve(root, 'test-results/screenshots/black-game.png'),
      fullPage: true,
    })
  })
  await check('failed opponent generation offers a working retry', async () => {
    modelFailure = true
    await page.goto(`${base}/game/new`)
    await page.getByRole('button', { name: 'Black Let the opponent begin' }).click()
    await page.getByRole('button', { name: 'Start learning', exact: true }).click()
    await page.getByRole('button', { name: 'Retry opponent', exact: true }).waitFor()
    modelFailure = false
    await page.getByRole('button', { name: 'Retry opponent', exact: true }).click()
    await page.getByRole('button', { name: 'View ply 1: e4', exact: true }).waitFor()
  })
  await check('promotion dialog traps focus and commits the selected underpromotion', async () => {
    const { newGame, commitMove } = await import(pathToFileURL(resolve(runtime, 'rules.mjs')))
    let promotionGame = newGame('alice', 'w', false)
    for (const [i, uci] of [
      'a2a4',
      'h7h5',
      'a4a5',
      'h5h4',
      'a5a6',
      'h4h3',
      'a6b7',
      'h3g2',
    ].entries())
      promotionGame = commitMove(promotionGame, i, uci, i % 2 ? 'opponent' : 'player')
    await store.put('games', 'promotion-fixture', promotionGame)
    await page.goto(`${base}/game/promotion-fixture`)
    await page.getByRole('button', { name: 'b7 White pawn', exact: true }).click()
    await page
      .getByRole('button', { name: 'a8 Black rook, legal destination', exact: true })
      .click()
    await page.getByRole('dialog').waitFor()
    await page.waitForFunction(
      () => document.querySelector('[role="dialog"]')?.contains(document.activeElement),
      {},
      { timeout: 1000 },
    )
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      // Base UI's focus guards redirect focus asynchronously when wrapping.
      // Assert the settled focus instead of sampling the guard between events.
      await page.waitForFunction(
        () => document.querySelector('[role="dialog"]')?.contains(document.activeElement),
        {},
        { timeout: 1000 },
      )
    }
    await page.screenshot({
      path: resolve(root, 'test-results/screenshots/promotion.png'),
      fullPage: true,
    })
    await page.getByRole('button', { name: 'Promote to knight', exact: true }).click()
    await page.getByRole('button', { name: 'View ply 9: bxa8=N', exact: true }).waitFor()
  })
  await check(
    'historical player moves preview an inline branch action, cancel safely and preserve the source',
    async () => {
      const { newGame, commitMove } = await import(pathToFileURL(resolve(runtime, 'rules.mjs')))
      let source = newGame('alice', 'w', false)
      for (const [i, uci] of ['e2e4', 'e7e5', 'g1f3', 'b8c6'].entries())
        source = commitMove(source, i, uci, i % 2 ? 'opponent' : 'player')
      const originalId = 'inline-branch-fixture'
      await store.put('games', originalId, source)
      const original = await store.get('games', originalId)
      await page.setViewportSize({ width: 1366, height: 768 })
      await page.goto(`${base}/game/${originalId}/analysis`)
      await page.getByRole('button', { name: 'View ply 1: e4', exact: true }).click()
      assert.equal(
        await page.getByRole('button', { name: 'c7 Black pawn', exact: true }).isDisabled(),
        true,
      )
      await page.getByRole('button', { name: 'View ply 2: e5', exact: true }).click()
      assert.equal(
        await page.getByRole('button', { name: '+ Create branch', exact: true }).count(),
        0,
      )
      const beforeCalls = calls.length
      const beforeActions = actionCount
      const gamesBefore = query('games').length
      await page.getByRole('button', { name: 'd2 White pawn', exact: true }).click()
      await page.getByRole('button', { name: 'd4 empty, legal destination', exact: true }).click()
      await page.getByRole('button', { name: '+ Create branch', exact: true }).waitFor()
      await page.getByRole('button', { name: 'd4 White pawn', exact: true }).waitFor()
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal(await page.getByLabel('Ask about the selected position').isDisabled(), true)
      assert.equal(calls.length, beforeCalls)
      assert.equal(actionCount, beforeActions, 'Preview is local until Create branch')
      const branchAction = await page
        .getByRole('button', { name: '+ Create branch', exact: true })
        .boundingBox()
      assert.ok(
        branchAction.y >= 73 && branchAction.y + branchAction.height <= 768,
        'Branch action is visible below the sticky header',
      )
      await page.screenshot({
        path: resolve(root, 'test-results/screenshots/branch-preview.png'),
        fullPage: true,
      })
      await page.setViewportSize({ width: 390, height: 844 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({
        path: resolve(root, 'test-results/screenshots/branch-preview-mobile.png'),
        fullPage: true,
      })
      await page.getByRole('button', { name: 'Cancel branch preview', exact: true }).click()
      await page.getByRole('button', { name: 'd2 White pawn', exact: true }).waitFor()
      assert.equal(query('games').length, gamesBefore)
      await page.getByRole('button', { name: 'd2 White pawn', exact: true }).click()
      await page.getByRole('button', { name: 'd4 empty, legal destination', exact: true }).click()
      await page.getByRole('button', { name: 'Previous move', exact: true }).click()
      assert.equal(
        await page.getByRole('button', { name: '+ Create branch', exact: true }).count(),
        0,
      )
      await page.getByRole('button', { name: 'Next move', exact: true }).click()
      await page.getByRole('button', { name: 'd2 White pawn', exact: true }).click()
      await page.getByRole('button', { name: 'd4 empty, legal destination', exact: true }).click()
      await page.getByRole('button', { name: '+ Create branch', exact: true }).click()
      await page.waitForURL(
        (url) => !url.href.includes(originalId) && /\/game\/game-/.test(url.pathname),
      )
      await page.getByRole('button', { name: 'View ply 3: d4', exact: true }).waitFor()
      await page.getByRole('link', { name: /View original game/ }).waitFor()
      assert.deepEqual((await store.get('games', originalId)).data, original.data)
      assert.equal(query('games').length, gamesBefore + 1)
      const branch = (await store.get('games', page.url().split('/').at(-1))).data
      assert.deepEqual(
        branch.moveHistory.slice(0, 3).map((m) => m.san),
        ['e4', 'e5', 'd4'],
      )
      assert.equal(branch.status, 'active')
      assert.equal(await page.locator('.message').count(), 0)
      await page.setViewportSize({ width: 1440, height: 1080 })
    },
  )
  await check(
    'diagnostics shows retained traces, filters, details and a compact mobile layout',
    async () => {
      const beforeCalls = calls.length
      await page.goto(`${base}/diagnostics`)
      await page.getByRole('heading', { name: 'See what happened.' }).waitFor()
      await page.locator('.diag-trace').first().waitFor()
      await page.getByLabel('Operation', { exact: true }).selectOption('ask')
      await page.getByLabel('Result', { exact: true }).selectOption('failed')
      await page.getByText('insufficient credits', { exact: true }).waitFor()
      const trace = [...traceRows.values()].find(
        (t) => t.operation === 'ask' && t.outcome === 'failed',
      )
      await page.getByPlaceholder('Paste a trace ID').fill(trace.traceId)
      assert.equal(await page.locator('.diag-trace').count(), 1)
      await page.locator('.diag-trace summary').click()
      await page.getByRole('cell', { name: 'model.failed', exact: true }).waitFor()
      await page.screenshot({
        path: resolve(root, 'test-results/screenshots/diagnostics-desktop.png'),
        fullPage: true,
      })
      await page.setViewportSize({ width: 390, height: 844 })
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'Dashboard has no mobile page overflow',
      )
      await page.screenshot({
        path: resolve(root, 'test-results/screenshots/diagnostics-mobile.png'),
        fullPage: true,
      })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByRole('cell', { name: 'model.failed', exact: true }).waitFor()
      assert.equal(calls.length, beforeCalls, 'Dashboard reads never invoke AI')
      await context.addCookies([{ name: 'test-user', value: 'bob', url: base }])
      await page.reload()
      await page.getByRole('alert').filter({ hasText: 'Only the app owner' }).waitFor()
      assert.equal(await page.locator('.diag-trace').count(), 0)
      await context.addCookies([{ name: 'test-user', value: 'alice', url: base }])
    },
  )
  console.log(
    `\n${checks} browser checks passed with explicit service doubles. Screenshots: test-results/screenshots.`,
  )
} catch (error) {
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages())
      await page
        .screenshot({ path: resolve(root, 'test-results/screenshots/failure.png'), fullPage: true })
        .catch(() => {})
  throw error
} finally {
  await browser?.close()
  await new Promise((r) => server.close(r))
}
