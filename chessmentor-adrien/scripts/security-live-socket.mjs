/** Uses the existing DeepSpace CLI user's cached credential only at their app.
 * Never prints the token, URL query, profile, or game contents. No AI/action calls.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
const token = (await readFile(join(homedir(), '.deepspace/token'), 'utf8')).trim()
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
if (!claims.exp || claims.exp * 1000 <= Date.now() || claims.scope) throw new Error('A current unscoped CLI user token is required; run a normal CLI authenticated command first.')
const endpoint = new URL('wss://chessmentor-ai.app.space/ws/app:app_01M7VPKT5JCR90ZS8Z43ZFP5WS')
endpoint.searchParams.set('token', token)
const socket = new WebSocket(endpoint)
await new Promise((resolve, reject) => {
  let read = false, heartbeat = false
  const timer = setTimeout(() => { socket.close(); reject(new Error('Live realtime verification timed out')) }, 15_000)
  function finish() { if (read && heartbeat) { clearTimeout(timer); socket.close(1000); resolve() } }
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({type:'core.subscribe',payload:{subscriptionId:'security-read',query:{collection:'games',limit:1}}}))
    socket.send('ping')
  })
  socket.addEventListener('message', event => {
    if (event.data === 'pong') { heartbeat = true; finish(); return }
    let value
    try { value = JSON.parse(event.data) } catch { return }
    if (value.type === 'core.query_result' && value.payload?.subscriptionId === 'security-read' && Array.isArray(value.payload.records)) { read = true; finish() }
  })
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Live authenticated realtime connection failed; no credential details logged')) })
})
console.log('PASS live authenticated WebSocket, owned-game read and heartbeat; no AI calls or game writes')
