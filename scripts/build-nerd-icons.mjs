#!/usr/bin/env node
// Rebuilds the vendored nerd-icon webfont (scripts/nerd-icon-glyphs.txt) and
// injects it into both client twins as a data-URI @font-face.
//
// Why a data URI: the DSH GUI machine has no Nerd Font installed, so p10k
// prompt icons reach the terminal as tofu hexboxes. The plugin cannot ask
// the host to install fonts (ADR 0001 — the Panel is plugin-local), so the
// font travels inside lib/client.js. The subset is icon-only
// (SymbolsNerdFontMono, private-use-area codepoints), so ASCII and box
// drawing still render from the system font stack named after it in
// TERM_FONT_FAMILY.
//
// Idempotent: re-running replaces the previous GENERATED block in each twin.
// Outputs land in node_modules/.cache/nerd-icons/ (never committed).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, 'node_modules/.cache/nerd-icons')
const FONT_URL = 'https://github.com/ryanoasis/nerd-fonts/releases/latest/download/NerdFontsSymbolsOnly.zip'
const FONT_TTF = join(cache, 'SymbolsNerdFontMono-Regular.ttf')
const WOFF2 = join(cache, 'rsb-nerd-icons.woff2')
const FAMILY = 'Dsh Sidebar Icons'
const OLD_STACK = "ui-monospace, SFMono-Regular, Menlo, monospace"
const NEW_STACK = `"${FAMILY}", ui-monospace, SFMono-Regular, Menlo, monospace`

// lib/client.js builds the stylesheet into a `const CSS = [...]` array;
// dynamic/client.js inserts it straight into `styles.insert([...])`. The
// generated block and the array reference must land before the first rule.
const TWINS = [
  {
    file: join(root, 'lib/client.js'),
    indent: '      ',
    arrayAnchor: 'const CSS = [',
  },
  {
    file: join(root, 'dynamic/client.js'),
    indent: '    ',
    arrayAnchor: 'styles.insert([',
  },
]

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: ['ignore', opts.quiet ? 'ignore' : 'inherit', 'inherit'] })
}

function log(msg) {
  console.log(`build-nerd-icons: ${msg}`)
}

// --- 1. glyph manifest -------------------------------------------------------
const glyphs = readFileSync(join(root, 'scripts/nerd-icon-glyphs.txt'), 'utf8')
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .join('')
  .replace(/\s+/g, '')
if (!/^[0-9A-F,.-]+$/i.test(glyphs)) throw new Error('nerd-icon-glyphs.txt: unexpected characters')

// --- 2. obtain the symbols font ---------------------------------------------
mkdirSync(cache, { recursive: true })
if (!existsSync(FONT_TTF)) {
  log('downloading NerdFontsSymbolsOnly.zip (~3 MB)')
  sh('curl', ['-sL', '--fail', '--max-time', '300', '-o', join(cache, 'symbols.zip'), FONT_URL])
  log('extracting SymbolsNerdFontMono-Regular.ttf')
  sh('unzip', ['-o', '-j', '-q', join(cache, 'symbols.zip'), 'SymbolsNerdFontMono-Regular.ttf', '-d', cache])
}

// --- 3. subset to woff2 ------------------------------------------------------
if (!existsSync(WOFF2)) {
  const venvBin = join(cache, 'venv/bin')
  if (!existsSync(join(venvBin, 'pyftsubset'))) {
    log('provisioning python venv with fonttools+brotli')
    sh('python3', ['-m', 'venv', join(cache, 'venv')], { quiet: true })
    sh(join(venvBin, 'pip'), ['install', '-q', 'fonttools', 'brotli'], { quiet: true })
  }
  log('subsetting to the p10k inventory')
  sh(join(venvBin, 'pyftsubset'), [
    FONT_TTF,
    '--output-file=' + WOFF2,
    '--flavor=woff2',
    '--unicodes=' + glyphs,
    '--layout-features=*',
    '--no-hinting',
    '--desubroutinize',
  ])
}
const b64 = readFileSync(WOFF2).toString('base64')
log(`subset woff2: ${WOFF2} (${b64.length} base64 chars)`)

// --- 4. inject into both client twins ---------------------------------------
const BEGIN = '// >>> GENERATED: vendored nerd-icon webfont'
const END = '// <<< END GENERATED <<<'
const face = `@font-face { font-family: "${FAMILY}"; src: url(data:font/woff2;base64,${b64}) format("woff2"); font-weight: normal; font-style: normal; font-display: block; unicode-range: U+E000-F8FF; }`

for (const twin of TWINS) {
  let src = readFileSync(twin.file, 'utf8')

  // Drop any previous generated block.
  const prev = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} {2}\\n`)
  src = src.replace(prev, '')

  const block = [
    `${twin.indent}${BEGIN} — p10k's default icon inventory`,
    `${twin.indent}// (private-use-area subset of SymbolsNerdFontMono), embedded as a data`,
    `${twin.indent}// URI so the Panel terminal renders prompt icons on machines with no`,
    `${twin.indent}// Nerd Font installed. Family name is quoted in TERM_FONT_FAMILY.`,
    `${twin.indent}// Rebuild with: npm run build:nerd-icons`,
    `${twin.indent}const TERM_ICON_FACE = '${face}'`,
    `${twin.indent}${END}`,
  ].join('\n')

  const anchor = `${twin.indent}${twin.arrayAnchor}`
  if (!src.includes(anchor)) throw new Error(`${twin.file}: anchor not found: ${twin.arrayAnchor}`)
  src = src.replace(anchor, `${block}\n${anchor}`)

  // Reference the face as the first stylesheet entry.
  const element = `${twin.indent}  TERM_ICON_FACE,`
  const open = `${anchor}\n`
  if (!src.includes(element)) src = src.replace(open, `${open}${element}\n`)

  // Point the terminal font stack at the face.
  const familyOld = `${twin.indent}const TERM_FONT_FAMILY = '${OLD_STACK}'`
  const familyNew = `${twin.indent}const TERM_FONT_FAMILY = '${NEW_STACK}'`
  if (src.includes(familyNew)) {
    log(`${twin.file}: TERM_FONT_FAMILY already updated`)
  } else if (src.includes(familyOld)) {
    src = src.replace(familyOld, familyNew)
  } else {
    throw new Error(`${twin.file}: TERM_FONT_FAMILY line not found`)
  }

  writeFileSync(twin.file, src)
  log(`${twin.file}: injected (${src.length} bytes)`)
}
