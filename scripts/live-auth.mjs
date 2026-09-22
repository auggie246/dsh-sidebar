#!/usr/bin/env node
// Live-GUI authentication for the scripts/verify-*.mjs checks.
//
// Every `dsh web` process mints a random launch token and prints one root URL
// that carries it:
//
//   dsh web: http://127.0.0.1:3080/?token=<token>
//
// `GET /?token=<token>` accepts the token once, writes an authority-bound
// signed cookie, and redirects to a clean `/`. Every later request needs that
// cookie; anything else gets 401 with "dsh web authentication required". Static
// assets stay public, so only the root document and the `/api` routes are gated.
//
// The token is process-scoped and is not written to disk, so a script cannot
// discover it. Supply one of these before running a verify script:
//
//   DSH_WEB_TOKEN=<the token from the `dsh web` start-up line>
//   DSH_WEB_COOKIE=<the cookie value for this origin, copied from devtools>
//
// The token is the better input: it is short-lived, it is what the GUI itself
// uses, and it needs no browser. The cookie is for a session whose token has
// scrolled away, and it works only for the plain-HTTP checks.
//
// This module is shared, unlike the per-suite test harnesses. Authentication is
// one transport concern with one implementation, and a copy in each of the ten
// verify scripts would be ten places to fix the same 401.

export const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'

const HELP = [
  'this check needs the browser session that `dsh web` prints at start-up,',
  'and none was supplied. Copy the token from that line and run again:',
  '',
  '  DSH_WEB_TOKEN=<token> node ' + (process.argv[1] ?? 'scripts/verify-…mjs'),
  '',
  'or reuse a browser cookie for the same origin:',
  '',
  '  DSH_WEB_COOKIE=<cookie> node ' + (process.argv[1] ?? 'scripts/verify-…mjs'),
  '',
  'The token is the part after `?token=` in the URL `dsh web` prints.',
].join('\n')

let session

/**
 * An error a CLI should read, not a stack trace. Every failure here is about the
 * caller's environment, so the stack — which points into this module — is noise.
 * @param message - what the operator must do.
 * @returns the error, with its stack reduced to the message.
 */
function liveError(message) {
  const error = new Error(message)
  error.stack = message
  return error
}

/**
 * Resolve the live browser session once per process. Exported for the callers in
 * `live-auth.mjs` itself and for the check in `scripts/test-live-auth.mjs`.
 * @returns {Promise<{ cookie: string, name: string, value: string, token: string }>}
 *   the `Cookie` header value, its name and value, and the launch token when one
 *   was supplied (an empty string otherwise).
 */
export async function liveSession() {
  if (session !== undefined) return session

  const supplied = (process.env.DSH_WEB_COOKIE ?? '').trim()
  if (supplied) {
    session = cookieParts(supplied, '')
    return session
  }

  const token = (process.env.DSH_WEB_TOKEN ?? '').trim()
  if (!token) throw liveError(HELP)

  const exchange = new URL('/', baseUrl)
  exchange.searchParams.set('token', token)
  let response
  try {
    response = await fetch(exchange, { redirect: 'manual' })
  } catch (error) {
    throw liveError(`${baseUrl} is unreachable (${error.message}). Is \`dsh web\` running?`)
  }
  const issued = response.headers.getSetCookie()
  const pair = issued.map((entry) => entry.split(';')[0]).filter((entry) => entry.includes('='))
  if (pair.length === 0) {
    throw liveError(
      `the launch token was refused (HTTP ${response.status}). Copy a fresh one from the current \`dsh web\` start-up line.\n\n${HELP}`,
    )
  }
  session = cookieParts(pair.join('; '), token)
  return session
}

function cookieParts(header, token) {
  // A Cookie header can carry several pairs; the first is the session cookie.
  const first = header.split(';')[0].trim()
  const at = first.indexOf('=')
  if (at <= 0) throw liveError('DSH_WEB_COOKIE must look like name=value; the supplied value has no name=value pair')
  return { cookie: header, name: first.slice(0, at), value: first.slice(at + 1), token }
}

/**
 * `fetch` that carries the browser session. Use it for every request the check
 * makes, including the served bundle: the GUI serves some assets publicly and
 * gates others, and sending the cookie works either way. No check depends on
 * which routes the GUI leaves public.
 * @param path - a path or URL on the GUI origin, such as `/`, `/api/x`, or the
 *   absolute bundle URL from the boot manifest.
 * @param init - ordinary `fetch` init; `headers` are preserved.
 * @returns the response.
 */
export async function liveFetch(path, init = {}) {
  const { cookie } = await liveSession()
  const headers = new Headers(init.headers)
  headers.set('cookie', cookie)
  return fetch(new URL(path, baseUrl), { ...init, headers })
}

/**
 * Give a headless Chrome its own copy of the session cookie, so every navigation
 * the script drives afterwards passes the check. Call it after attaching to the
 * target and before the first `Page.navigate`.
 * @param cdp - a client with `send(method, params, sessionId)`.
 * @param sessionId - the attached target session.
 */
export async function authorizeBrowser(cdp, sessionId) {
  const { name, value } = await liveSession()
  await cdp.send('Network.enable', {}, sessionId)
  const result = await cdp.send('Network.setCookie', { name, value, url: baseUrl }, sessionId)
  if (result?.success === false) throw liveError('Chrome refused the browser-session cookie')
}
