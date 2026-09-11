#!/usr/bin/env node
// GUI-level verification for ticket #1 (Rail button bar) and ADR 0008 (toggle
// seats): the running GUI must serve a client bundle whose hero Rail is the
// two-button bar with currentColor glyphs, whose in-session Header Toggles
// register on the session-header utilities row, with no `»` header collapse
// control, and the inert Panel button title.
const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const response = await fetch(baseUrl)
const html = await response.text()
if (!response.ok) {
  console.error(`Rail button bar check FAILED: ${baseUrl} returned HTTP ${response.status}`)
  process.exit(1)
}

const marker = '__DSH_BOOT__'
const at = html.indexOf(marker)
const open = html.indexOf('{', at)
let depth = 0
let end = -1
for (let i = open; i < html.length; i++) {
  const ch = html[i]
  if (ch === '{') depth++
  else if (ch === '}') {
    depth--
    if (depth === 0) { end = i + 1; break }
  }
}
if (at === -1 || open === -1 || end === -1) {
  console.error('Rail button bar check FAILED: DSH boot manifest was not found.')
  process.exit(1)
}
let boot
try {
  boot = JSON.parse(html.slice(open, end))
} catch (error) {
  console.error(`Rail button bar check FAILED: boot manifest is invalid JSON: ${error.message}`)
  process.exit(1)
}
const sidebar = boot.entries?.find((entry) => entry.id === 'dsh-sidebar')
if (!sidebar?.url) {
  console.error('Rail button bar check FAILED: dsh-sidebar is absent from the boot manifest.')
  process.exit(1)
}
const bundleResponse = await fetch(new URL(sidebar.url, baseUrl))
const bundle = await bundleResponse.text()
if (!bundleResponse.ok) {
  console.error('Rail button bar check FAILED: the advertised browser bundle is unavailable.')
  process.exit(1)
}

function fail(message) {
  console.error(`Rail button bar check FAILED: ${message}`)
  process.exit(1)
}
if (!/h\('div', \{ className: 'rsb-rail' \}/.test(bundle)) fail('the hero Rail container div was not found')
if (!/h\('div', \{ className: 'rsb-header-toggles' \}/.test(bundle)) fail('the Header Toggles container div was not found')
if (!bundle.includes("'conversation.session.header.utilities'")) fail('the header utilities registration is missing')
if (!bundle.includes("'Panel opens once a session exists'")) fail('the inert Panel button title was not found')
if (bundle.includes("'Collapse sidebar'")) fail('the » header collapse control is still present')
if (bundle.includes("'»'")) fail('the » glyph is still rendered somewhere')
if (!bundle.includes('fill: \'currentColor\'') || !bundle.includes('stroke: \'currentColor\'')) {
  fail('the glyphs do not draw with currentColor')
}
if (!bundle.includes('.rsb-rail button:disabled')) fail('the disabled Rail button style is missing')
if (!/rsb-rail button \{[^}]*height: 36px/.test(bundle)) fail('the two stacked 36px button targets are missing')
if (!bundle.includes('.rsb-header-toggles button:disabled')) fail('the disabled Header Toggles button style is missing')

console.log('Toggle seat check passed: the running GUI serves the hero Rail and the in-session Header Toggles')
