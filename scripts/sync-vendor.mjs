#!/usr/bin/env node
/**
 * Inlines the vendored prebuilt libraries into BOTH client twins (ticket #8,
 * issue #27). The GUI serves client plugins verbatim — one file per plugin,
 * sibling paths 404 — so a vendored library cannot be a sibling file and must
 * live inside lib/client.js and dynamic/client.js themselves.
 *
 * Two libraries are generated, each between its own fixed marker pair that
 * must already exist in every twin (the script never creates markers):
 *
 *   // >>> GENERATED: vendored @xterm/xterm 5.5.0 — edit lib/vendor/xterm/ and run: npm run sync:vendor >>>
 *   // <<< END GENERATED vendored block <<<
 *   // >>> GENERATED: vendored prismjs 1.29.0 — edit lib/vendor/prism/ and run: npm run sync:vendor >>>
 *   // <<< END GENERATED prism block <<<
 *
 * Re-running replaces each block byte-for-byte, so the script is idempotent.
 *
 * xterm: the inner `module`/`exports` consts shadow the plugin's own ones, so
 * the UMD header's CommonJS branch assigns the library into the IIFE instead
 * of clobbering the plugin's exports. xterm reads `navigator`/`window` at load
 * time (its browser-detection module), so the capture degrades to `null` on
 * hosts without them (node:vm test harnesses) instead of throwing; the
 * Terminal tab then renders its fallback output view.
 *
 * Prism: prism-core declares `var Prism` inside the IIFE, so every language
 * component — a plain script that assigns into the global `Prism.languages` —
 * resolves to that IIFE-local binding. Components are concatenated in
 * dependency order (a language that extends another must follow it). Like
 * xterm, the capture degrades to `null` where the browser globals are absent;
 * the Text Preview then renders its lines uncoloured.
 */
import { readFile, writeFile } from 'node:fs/promises'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = ['lib/client.js', 'dynamic/client.js']

function fail(message) {
  console.error(`sync-vendor: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// @xterm/xterm
// ---------------------------------------------------------------------------

const XTERM_BEGIN = '// >>> GENERATED: vendored @xterm/xterm 5.5.0 — edit lib/vendor/xterm/ and run: npm run sync:vendor >>>'
const XTERM_END = '// <<< END GENERATED vendored block <<<'

const xtermJs = await readFile(join(root, 'lib/vendor/xterm/xterm.js'), 'utf8')
const xtermCss = await readFile(join(root, 'lib/vendor/xterm/xterm.css'), 'utf8')

// The generated block (identical in both twins).
const xtermBlock = [
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
  new Function(xtermBlock)
} catch (e) {
  fail(`the generated XTERM block does not parse: ${e && e.message}`)
}

// 2. The block must actually capture the library when browser globals exist
//    (xterm does not touch the DOM at load time, so a minimal vm suffices).
const xtermBrowserish = vm.runInNewContext(
  `${xtermBlock}\n;({ terminal: typeof XTERM.Terminal, css: typeof XTERM.css })`,
  { navigator: { userAgent: 'sync-vendor', platform: 'MacIntel' }, window: {}, console },
)
if (xtermBrowserish.terminal !== 'function' || xtermBrowserish.css !== 'string') {
  fail(`the generated XTERM block did not capture the library (Terminal: ${xtermBrowserish.terminal}, css: ${xtermBrowserish.css})`)
}

// 3. The block must degrade to null — not throw — when those globals are
//    absent, because the vm test harnesses boot the whole client file.
const xtermBare = vm.runInNewContext(`${xtermBlock}\n;String(XTERM)`, { console })
if (xtermBare !== 'null') {
  fail(`the generated XTERM block must degrade to null without browser globals, got ${xtermBare}`)
}

// ---------------------------------------------------------------------------
// prismjs
// ---------------------------------------------------------------------------

const PRISM_BEGIN = '// >>> GENERATED: vendored prismjs 1.29.0 — edit lib/vendor/prism/ and run: npm run sync:vendor >>>'
const PRISM_END = '// <<< END GENERATED prism block <<<'
const PRISM_DIR = 'lib/vendor/prism'

// Dependency order. Core first, then every component after the language it
// extends (c before cpp, jsx and typescript before tsx, markup before
// markdown, javascript before jsx and typescript).
const PRISM_FILES = [
  'prism-core.min.js',
  'prism-clike.min.js',
  'prism-markup.min.js',
  'prism-css.min.js',
  'prism-javascript.min.js',
  'prism-bash.min.js',
  'prism-c.min.js',
  'prism-cpp.min.js',
  'prism-csharp.min.js',
  'prism-diff.min.js',
  'prism-docker.min.js',
  'prism-go.min.js',
  'prism-ini.min.js',
  'prism-java.min.js',
  'prism-json.min.js',
  'prism-jsx.min.js',
  'prism-markdown.min.js',
  'prism-python.min.js',
  'prism-ruby.min.js',
  'prism-rust.min.js',
  'prism-sql.min.js',
  'prism-toml.min.js',
  'prism-typescript.min.js',
  'prism-tsx.min.js',
  'prism-yaml.min.js',
]

const prismSources = []
for (const file of PRISM_FILES) {
  prismSources.push(await readFile(join(root, PRISM_DIR, file), 'utf8'))
}

const prismBlock = [
  'const PRISM = (function () {',
  '  // Prism loads and colours with no browser globals at all, so the node',
  '  // suites can assert one result for both twins. The capture still',
  '  // degrades to null rather than throwing if a component ever needs the',
  '  // DOM; the Text Preview then renders its lines uncoloured.',
  '  try {',
  '    const module = { exports: {} }',
  '    const exports = module.exports',
  ...prismSources.map((source, i) => (i === 0 ? `    ${source}` : `    ;${source}`)),
  '    return {',
  '      languages: Prism.languages,',
  '      highlight: function (code, lang) { return Prism.highlight(code, Prism.languages[lang], lang) },',
  '    }',
  '  } catch (e) { return null }',
  '})()',
].join('\n')

// 1. Parse as a standalone function body.
try {
  new Function(prismBlock)
} catch (e) {
  fail(`the generated PRISM block does not parse: ${e && e.message}`)
}

// 2. Every component must have loaded, and the capture must colour a sample
//    in a language that extends another (tsx needs jsx and typescript).
const prismProbe = vm.runInNewContext(
  `${prismBlock}\n;({
    kind: typeof PRISM,
    count: PRISM ? Object.keys(PRISM.languages).length : 0,
    js: PRISM ? PRISM.highlight('const a = 1', 'javascript') : '',
    tsx: PRISM ? PRISM.highlight('const a: number = 1', 'tsx') : '',
    bash: PRISM ? PRISM.highlight('echo hi', 'bash') : '',
  })`,
  { console },
)
if (prismProbe.kind !== 'object') fail('the generated PRISM block must capture the library without browser globals')
if (prismProbe.count < 25) fail(`the generated PRISM block loaded only ${prismProbe.count} languages`)
for (const [name, html] of [['javascript', prismProbe.js], ['tsx', prismProbe.tsx], ['bash', prismProbe.bash]]) {
  if (html.indexOf('token') === -1) fail(`the generated PRISM block did not colour a ${name} sample: ${html}`)
}

// 3. Prism runs headless with no browser globals at all, which is what lets
//    the node suites assert one highlighting result for both twins. A browser
//    window must not change that result either.
const prismHeadless = vm.runInNewContext(`${prismBlock}\n;PRISM.highlight('const a = 1', 'javascript')`, { console })
if (prismHeadless.indexOf('token') === -1) fail(`the generated PRISM block must colour headless too, got ${prismHeadless}`)
const prismWindowed = vm.runInNewContext(`${prismBlock}\n;PRISM.highlight('const a = 1', 'javascript')`, { console, window: {}, self: {} })
if (prismWindowed !== prismHeadless) fail('the generated PRISM block must colour the same with and without a window')

// ---------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------

/** Replace the text between one marker pair in one twin. */
async function rewrite(target, begin, end, block) {
  const file = join(root, target)
  const text = await readFile(file, 'utf8')
  const beginAt = text.indexOf(begin)
  if (beginAt === -1) fail(`${target} is missing the marker: ${begin}`)
  const endAt = text.indexOf(end)
  if (endAt === -1 || endAt < beginAt) fail(`${target} is missing the marker: ${end}`)
  if (text.indexOf(begin, beginAt + 1) !== -1) fail(`${target} carries more than one copy of: ${begin}`)
  if (text.indexOf(end, endAt + end.length) !== -1) fail(`${target} carries more than one copy of: ${end}`)
  const next = text.slice(0, beginAt + begin.length) + '\n' + block + '\n' + text.slice(endAt)
  if (next === text) {
    console.log(`sync-vendor: ${target} already up to date`)
    return
  }
  await writeFile(file, next, 'utf8')
  console.log(`sync-vendor: rewrote ${target} (${block.length} byte block)`)
}

for (const target of TARGETS) {
  await rewrite(target, XTERM_BEGIN, XTERM_END, xtermBlock)
  await rewrite(target, PRISM_BEGIN, PRISM_END, prismBlock)
}
