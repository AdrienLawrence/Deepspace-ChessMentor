/** Bounded, unauthenticated checks only. Never creates games or invokes AI. */
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
const origin = 'https://chessmentor-ai.app.space'
const checks = [
  ['/api/actions/chess', 'POST', 401],
  ['/api/actions/diagnostics', 'POST', 401],
  ['/api/integrations/openai/chat-completion', 'POST', 403],
  ['/api/integrations/anthropic/messages', 'POST', 403],
  ['/api/files/upload', 'POST', 404],
  ['/api/debug/sql', 'POST', 404],
  ['/_deepspace/charges/create', 'POST', 404],
  ['/_deepspace/agent/browser/tools', 'GET', 401],
  ['/internal/chess', 'POST', 404],
  ['/ws/arbitrary-room', 'GET', 404],
  ['/ws/app:app_01M7VPKT5JCR90ZS8Z43ZFP5WS', 'GET', 401],
  ['/.dev.vars', 'GET', 404],
  ['/worker.ts', 'GET', 404],
  ['/api/auth/sign-out', 'GET', 405],
]
for (const [path, method, expected] of checks) {
  const response = await fetch(origin + path, { method, redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', 'X-App-Action':'true', 'X-User-Id':'forged-owner' }, ...(method === 'POST' ? {body:'{}'} : {}) })
  assert.equal(response.status, expected, `${method} ${path}`)
  if (path.startsWith('/api/')) assert.equal(response.headers.get('Cache-Control'), 'no-store')
  console.log(`PASS ${method} ${path} ${response.status}`)
}
const csrf = await fetch(origin+'/api/actions/chess', {method:'POST',headers:{Origin:'https://example.invalid','Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15_000)})
assert.equal(csrf.status,403)
const page = await fetch(origin, {signal:AbortSignal.timeout(15_000)})
assert.equal(page.status,200)
assert.match(page.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/)
assert.equal(page.headers.get('X-Content-Type-Options'),'nosniff')
assert.equal(page.headers.get('Referrer-Policy'),'no-referrer')
console.log('PASS cross-origin denial and public security headers')
const browser = await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true})
try {
  const context = await browser.newContext()
  const tab = await context.newPage()
  const errors = []
  tab.on('pageerror', error => errors.push(error.message))
  await tab.goto(origin, {waitUntil:'networkidle'})
  await tab.goto(origin+'/game/new', {waitUntil:'networkidle'})
  await tab.getByRole('heading',{name:'Sign in to continue'}).waitFor()
  await tab.getByRole('button',{name:'Sign in',exact:true}).click()
  await tab.getByRole('button',{name:/Google/}).waitFor()
  assert.equal(errors.length,0,'Guest sign-in flow must have no runtime errors')
  console.log('PASS live guest sign-in UI and Google button; no authentication or paid action attempted')
} finally { await browser.close() }
