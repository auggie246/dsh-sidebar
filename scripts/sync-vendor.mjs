#!/usr/bin/env node
/**
 * Inlines the vendored @xterm/xterm prebuilt library into BOTH client twins
 * (ticket #8). The GUI serves client plugins verbatim — one file per plugin,
 * sibling paths 404 — so the vendored library cannot be a sibling file and
 * must live inside lib/client.js and dynamic/client.js themselves.
 *
 * The generated block is written between a fixed marker pair that must
 * already exist in each twin (the script never creates markers):
 *
 *   // >>> GENERATED: vendored @xterm/xterm 5.5.0 — edit lib/vendor/xterm/ and run: npm run sync:vendor >>>
 *   // <<< END GENERATED vendored block <<<
 *
 * Re-running replaces the block byte-for-byte, so the script is idempotent.
 *
 * The inner `module`/`exports` consts shadow the plugin's own ones, so the
 * UMD header's CommonJS branch assigns the library into the IIFE instead of
 * clobbering the plugin's exports. xterm reads `navigator`/`window` at load
 * time (its browser-detection module), so the capture degrades to `null` on
 * hosts without them (node:vm test harnesses) instead of throwing; the
 * Terminal tab then renders its fallback output view.
 */
import { readFile, writeFile } from 'node:fs/promises'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BEGIN = '// >>> GENERATED: vendored @xterm/xterm 5.5.0 — edit lib/vendor/xterm/ and run: npm run sync:vendor >>>'
const END = '// <<< END GENERATED vendored block <<<'
const TARGETS = ['lib/client.js', 'dynamic/client.js']

function fail(message) {
  console.error(`sync-vendor: ${message}`)
  process.exit(1)
}

const xtermJs = await readFile(join(root, 'lib/vendor/xterm/xterm.js'), 'utf8')
const xtermCss = await readFile(join(root, 'lib/vendor/xterm/xterm.css'), 'utf8')

// The generated block (identical in both twins).
const block = [
  'const XTERM = (function () {',
  '  // xterm reads navigator/window at load; a host without them (node:vm',
  '  // test harnesses) degrades to null and the Terminal tab falls back to',
  '  // plain output instead of throwing during plugin load.',
  '  try {',
  '    const module = { exports: {} }',
  '    const exports = module.exports',
  `    ;${xtermJs}`,
  '    return {',
  "      Terminal: (typeof module.exports === 'function' ? module.exports : module.exports && module.exports.Terminal),",
  `      css: ${JSON.stringify(xtermCss)},`,
  '    }',
  '  } catch (e) { return null }',
  '})()',
].join('\n')

// 1. The block must parse as a standalone function body.
try {
  new Function(block)
} catch (e) {
  fail(`the generated XTERM block does not parse: ${e && e.message}`)
}

// 2. The block must actually capture the library when browser globals exist
//    (xterm does not touch the DOM at load time, so a minimal vm suffices).
const browserish = vm.runInNewContext(
  `${block}\n;({ terminal: typeof XTERM.Terminal, css: typeof XTERM.css })`,
  { navigator: { userAgent: 'sync-vendor', platform: 'MacIntel' }, window: {}, console },
)
if (browserish.terminal !== 'function' || browserish.css !== 'string') {
  fail(`the generated XTERM block did not capture the library (Terminal: ${browserish.terminal}, css: ${browserish.css})`)
}

// 3. The block must degrade to null — not throw — when those globals are
//    absent, because the vm test harnesses boot the whole client file.
const bare = vm.runInNewContext(`${block}\n;String(XTERM)`, { console })
if (bare !== 'null') {
  fail(`the generated XTERM block must degrade to null without browser globals, got ${bare}`)
}

// 4. Rewrite the content between the marker pair in every twin.
for (const target of TARGETS) {
  const file = join(root, target)
  const text = await readFile(file, 'utf8')
  const begin = text.indexOf(BEGIN)
  if (begin === -1) fail(`${target} is missing the GENERATED begin marker`)
  const end = text.indexOf(END)
  if (end === -1 || end < begin) fail(`${target} is missing the GENERATED end marker`)
  if (text.indexOf(BEGIN, begin + 1) !== -1) fail(`${target} carries more than one GENERATED begin marker`)
  if (text.indexOf(END, end + END.length) !== -1) fail(`${target} carries more than one GENERATED end marker`)
  const next = text.slice(0, begin + BEGIN.length) + '\n' + block + '\n' + text.slice(end)
  if (next !== text) {
    await writeFile(file, next, 'utf8')
    console.log(`sync-vendor: rewrote ${target} (${block.length} byte block)`)
  } else {
    console.log(`sync-vendor: ${target} already up to date`)
  }
}
