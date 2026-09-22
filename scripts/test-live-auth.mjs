#!/usr/bin/env node
// Live-auth helper check: the scripts/verify-*.mjs family must reach a running
// GUI that demands the browser session `dsh web` prints at start-up, and each
// must say what is missing when it cannot.
//
// A fixture server reproduces the real contract: `GET /?token=<good>` writes the
// session cookie and redirects to `/`, `GET /` answers only for that cookie, and
// every other request gets 401. The helper is imported fresh per case with a
// cache-busting query, because it caches the session for the life of one process.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const COOKIE = 'dsh-browser-session=v1.test-body.test-signature'
const seen = []
let exchanges = 0

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === 'good') {
    exchanges++
    res.writeHead(302, { 'set-cookie': `${COOKIE}; Max-Age=60; Path=/; HttpOnly; SameSite=Strict`, location: '/' })
    res.end()
    return
  }
  const carried = String(req.headers.cookie ?? '').split(';').map((part) => part.trim())
  if (!carried.includes(COOKIE)) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
    return
  }
  seen.push(url.pathname)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><script>window.__DSH_BOOT__ = {}</script>')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
process.env.DSH_WEB_URL = origin

/** One fresh module instance per case: the helper caches its session. */
let caseNumber = 0
async function freshHelper() {
  return import(`./live-auth.mjs?case=${++caseNumber}`)
}

function clearCredentials() {
  delete process.env.DSH_WEB_TOKEN
  delete process.env.DSH_WEB_COOKIE
}

// 1. No credential: the helper refuses to guess, and names both ways in.
{
  clearCredentials()
  const { liveFetch, baseUrl } = await freshHelper()
  assert.equal(baseUrl, origin, 'the helper must read DSH_WEB_URL')
  await assert.rejects(
    () => liveFetch('/'),
    (error) => {
      assert.match(error.message, /DSH_WEB_TOKEN=/, 'the message must show how to pass the token')
      assert.match(error.message, /DSH_WEB_COOKIE=/, 'the message must offer the cookie alternative')
      assert.match(error.message, /dsh web/, 'the message must say where the token comes from')
      return true
    },
    'a missing credential must fail with guidance, not a bare 401',
  )
  assert.equal(seen.length, 0, 'no request may carry a credential-less call through')
}

// 2. A wrong token: the server refuses the exchange, and the helper says so.
{
  clearCredentials()
  process.env.DSH_WEB_TOKEN = 'wrong'
  const { liveFetch } = await freshHelper()
  await assert.rejects(() => liveFetch('/'), /token was refused \(HTTP 401\)/, 'a refused token must name the HTTP status')
  assert.equal(seen.length, 0, 'a refused token must not authenticate anything')
}

// 3. A good token: one exchange, then the cookie carries every later request.
{
  clearCredentials()
  process.env.DSH_WEB_TOKEN = 'good'
  const before = exchanges
  const { liveFetch, liveSession } = await freshHelper()
  const response = await liveFetch('/')
  assert.equal(response.status, 200, 'the exchanged cookie must authenticate the root document')
  assert.equal(exchanges - before, 1, 'the token must be exchanged exactly once')
  await liveFetch('/api/rsidebarGit/status', { method: 'POST' })
  assert.deepEqual(seen, ['/', '/api/rsidebarGit/status'], 'the same cookie must carry the API route')
  assert.equal(exchanges - before, 1, 'a cached session must not exchange the token again')
  const session = await liveSession()
  assert.equal(session.token, 'good', 'the session must remember that a token was used')
}

// 4. A supplied cookie: no exchange, and the cookie is used as given.
{
  clearCredentials()
  process.env.DSH_WEB_COOKIE = COOKIE
  const before = exchanges
  const { liveFetch, liveSession } = await freshHelper()
  assert.equal((await liveFetch('/')).status, 200, 'a supplied cookie must authenticate the root document')
  assert.equal(exchanges, before, 'a supplied cookie must not trigger a token exchange')
  assert.equal((await liveSession()).token, '', 'no token was involved')
}

// 5. A browser gets the cookie before it navigates.
{
  clearCredentials()
  process.env.DSH_WEB_TOKEN = 'good'
  const { authorizeBrowser } = await freshHelper()
  const cdp = {
    calls: [],
    async send(method, params, sessionId) {
      this.calls.push({ method, params, sessionId })
      return { success: true }
    },
  }
  await authorizeBrowser(cdp, 'session-1')
  assert.deepEqual(cdp.calls.map((call) => call.method), ['Network.enable', 'Network.setCookie'], 'the browser must be enabled then given the cookie')
  const set = cdp.calls[1]
  assert.equal(set.params.name, COOKIE.split('=')[0], 'the cookie name must come from the exchange')
  assert.equal(set.params.value, COOKIE.split('=')[1], 'the cookie value must come from the exchange')
  assert.equal(set.params.url, origin, 'the cookie must be scoped to the GUI origin')
  assert.equal(set.sessionId, 'session-1', 'both calls must ride the attached target')
}

// 6. A refused cookie write is a failure, not a silent pass.
{
  clearCredentials()
  process.env.DSH_WEB_COOKIE = COOKIE
  const { authorizeBrowser } = await freshHelper()
  const cdp = { async send() { return { success: false } } }
  await assert.rejects(() => authorizeBrowser(cdp, 'session-2'), /refused the browser-session cookie/, 'a refused cookie write must throw')
}

server.close()
console.log('live-auth check passed')
