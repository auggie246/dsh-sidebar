#!/usr/bin/env node
// GUI-level verification for ticket #1 (Rail button bar): the running GUI must
// serve a client bundle whose Rail is the two-button bar with currentColor
// glyphs, no `»` header collapse control, and the inert Panel button.
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
if (!/h\('div', \{ className: 'rsb-rail' \}/.test(bundle)) fail('the Rail container div was not found')
if (!bundle.includes("'Panel is not available yet'")) fail('the inert Panel button was not found')
if (!bundle.includes("disabled: true")) fail('the Panel button is not disabled')
if (bundle.includes("'Collapse sidebar'")) fail('the » header collapse control is still present')
if (bundle.includes("'»'")) fail('the » glyph is still rendered somewhere')
if (!bundle.includes('fill: \'currentColor\'') || !bundle.includes('stroke: \'currentColor\'')) {
  fail('the glyphs do not draw with currentColor')
}
if (!bundle.includes('.rsb-rail button:disabled')) fail('the disabled-button style is missing')
if (!/rsb-rail button \{[^}]*height: 36px/.test(bundle)) fail('the two stacked 36px button targets are missing')

console.log('Rail button bar check passed: the running GUI serves the two-button Rail')
