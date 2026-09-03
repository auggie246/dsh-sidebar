// Regression test for issue #16: the Source Control Commit button and the
// Panel tab "Open" button hardcode `color: #ffffff` on a
// `var(--dsw-alias-brand-primary)` fill. DSH resolves that token to the
// theme's ink accent — #0f1115 (near-black) in the light theme, #f9fafb
// (near-white) in the dark theme — so in the dark theme the label rendered
// white-on-white at 1.05:1 contrast: a button with no visible text.
//
// The host's own primary buttons pair that fill with
// `var(--dsw-alias-label-primary-foreground)`, which flips with the theme.
// This test extracts both rules from the client sources, resolves them
// against the real theme token tables of the DSH checkout, and asserts a
// WCAG contrast of at least 4.5:1 in both themes. It also asserts both
// buttons still render a non-empty text label.
//
// The DSH checkout is not an npm dependency, so environments without one —
// CI runners — skip instead of failing (same convention as
// test-git-sandbox-policy.mjs).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function findDshRoot() {
  if (process.env.DSH_ROOT && existsSync(process.env.DSH_ROOT)) return process.env.DSH_ROOT
  const miseNode = join(process.env.HOME ?? '', '.local/share/mise/installs/node')
  try {
    for (const version of readdirSync(miseNode)) {
      const candidate = join(miseNode, version, 'lib/node_modules/@deepseek-ai/dsh')
      if (existsSync(candidate)) return candidate
    }
  } catch {}
  return null
}

const dshRoot = findDshRoot()
if (!dshRoot) {
  console.log('skipped: DSH checkout not found (set DSH_ROOT to run this check)')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Theme token tables, straight from the installed DSH theme plugin.
// The file holds one contiguous definition block per theme. The block is
// identified by its border-l2 alias: black-alpha in the light theme,
// white-alpha in the dark theme. Every theme-scoped token is defined exactly
// once per block (two sites overall), so attributing each definition site to
// its nearest border-l2 marker resolves each token per theme unambiguously.
// ---------------------------------------------------------------------------
const themeSrc = readFileSync(
  join(dshRoot, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
  'utf8',
)

const markers = {
  light: themeSrc.indexOf('--dsw-alias-border-l2:#0000001a'),
  dark: themeSrc.indexOf('--dsw-alias-border-l2:#ffffff1f'),
}
if (markers.light < 0 || markers.dark < 0) {
  console.log('skipped: DSH theme token tables not found at', dshRoot)
  process.exit(0)
}

const sitesByToken = new Map()
for (const m of themeSrc.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}"']+)/g)) {
  const list = sitesByToken.get(m[1]) ?? []
  list.push({ index: m.index, value: m[2].trim() })
  sitesByToken.set(m[1], list)
}

function resolveToken(name, theme, depth = 0) {
  if (depth > 16) return null // cycle guard
  const sites = sitesByToken.get(name)
  if (!sites || sites.length !== 2) return null // not a per-theme token pair
  const marker = markers[theme]
  const site = sites.reduce((a, b) => (Math.abs(b.index - marker) < Math.abs(a.index - marker) ? b : a))
  const varRef = site.value.match(/^var\((--[a-z0-9-]+)\)$/)
  if (varRef) return resolveToken(varRef[1], theme, depth + 1)
  return parseColor(site.value)
}

function parseColor(value) {
  const hex = value.match(/^#([0-9a-fA-F]{3,8})$/)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3) return [0, 1, 2].map((i) => parseInt(digits[i] + digits[i], 16))
    if (digits.length === 6) return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16))
    return null // alpha-bearing or malformed hex: not a flat color
  }
  const rgb = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/)
  if (rgb) return rgb.slice(1).map(Number)
  return null
}

function luminance([r, g, b]) {
  const channel = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

// ---------------------------------------------------------------------------
// Client sources: the rules under test and their button labels.
// ---------------------------------------------------------------------------
const sources = [
  ['lib/client.js', readFileSync(join(root, 'lib/client.js'), 'utf8')],
  ['dynamic/client.js', readFileSync(join(root, 'dynamic/client.js'), 'utf8')],
]

const BUTTONS = ['rsb-commit', 'rsb-tab-picker-open']

function ruleBody(src, className) {
  const m = src.match(new RegExp('\\.' + className + ' \\{([^}]*)\\}'))
  if (!m) throw new Error(`missing .${className} rule`)
  return m[1]
}

function declaration(body, prop) {
  const m = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)'))
  return m ? m[1].trim() : null
}

function resolveDeclaration(value, theme) {
  if (!value) return null
  const varRef = value.match(/var\((--[a-z0-9-]+)\)/)
  if (varRef) return resolveToken(varRef[1], theme)
  return parseColor(value)
}

// Assert each button's render call still passes a non-empty text label:
// scan the h('button', {...}) call whose balanced parens enclose the
// className, skipping the tag literal and the props object.
function labelLiterals(src, className) {
  const found = []
  for (const m of src.matchAll(new RegExp("className: '" + className + "'", 'g'))) {
    const call = src.lastIndexOf("h('button'", m.index)
    if (call < 0) continue
    let depth = 0
    let end = -1
    for (let i = call; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) continue
    const openBrace = src.indexOf('{', call)
    const closeBrace = src.indexOf('}', openBrace)
    const childrenStart = openBrace > 0 && closeBrace > openBrace && closeBrace < end ? closeBrace + 1 : call
    const span = src.slice(childrenStart, end)
    found.push(...[...span.matchAll(/'([^']*)'/g)].map((s) => s[1]).filter((s) => /\S/.test(s)))
  }
  return found
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const failures = []
const report = []

for (const [file, src] of sources) {
  for (const className of BUTTONS) {
    const labels = labelLiterals(src, className)
    if (labels.length === 0) failures.push(`${file}: .${className} button renders no non-empty text label`)
    else report.push(`${file}: .${className} label ok (${labels.length} call(s), e.g. "${labels[0]}")`)

    const body = ruleBody(src, className)
    const bgDecl = declaration(body, 'background')
    const fgDecl = declaration(body, 'color')
    for (const theme of Object.keys(markers)) {
      const bg = resolveDeclaration(bgDecl, theme)
      const fg = resolveDeclaration(fgDecl, theme)
      if (!bg || !fg) {
        failures.push(`${file}: .${className} in ${theme} theme — unresolvable colors (background: ${bgDecl}, color: ${fgDecl})`)
        continue
      }
      const ratio = contrast(bg, fg)
      const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
      report.push(`${file}: .${className} ${theme} theme — bg ${hex(bg)} on text ${hex(fg)} = ${ratio.toFixed(2)}:1`)
      if (ratio < 4.5) {
        failures.push(`${file}: .${className} ${theme} theme — contrast ${ratio.toFixed(2)}:1 is below 4.5:1 (background: ${bgDecl}; color: ${fgDecl})`)
      }
    }
  }
}

for (const line of report) console.log(line)
if (failures.length > 0) {
  console.error('\nFAIL:')
  for (const line of failures) console.error('  ' + line)
  process.exit(1)
}
console.log('\nok: both buttons keep a visible label in both DSH themes')
