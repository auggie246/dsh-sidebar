import { readFileSync, writeFileSync } from 'node:fs'

// Re-apply ticket #7's additions onto the merged (issue-8-based) files,
// using #7's committed versions as the extraction source and the surviving
// seam(#7) anchors as the insertion points.

function extract(src, from, to) {
  const lines = src.split('\n')
  const a = lines.findIndex((l) => l.includes(from))
  const b = lines.findIndex((l) => l.includes(to))
  if (a === -1 || b === -1 || b <= a) throw new Error('markers not found: ' + from + ' / ' + to)
  return lines.slice(a, b).join('\n').replace(/\n$/, '')
}
function sliceAfter(src, after, to) {
  const at = src.indexOf(after)
  const end = src.indexOf(to)
  if (at === -1 || end === -1 || end <= at) throw new Error('slice markers not found: ' + after.slice(0, 30))
  return src.slice(at + after.length, end).replace(/^\n/, '').replace(/\n$/, '')
}
function insert(file, marker, block) {
  let s = readFileSync(file, 'utf8')
  if (!s.includes(marker)) throw new Error(file + ' marker missing: ' + marker.slice(0, 60))
  s = s.replace(marker, block + '\n' + marker)
  writeFileSync(file, s)
}

const lib7 = readFileSync('/tmp/lib7.js', 'utf8')
const LIB = 'lib/client.js'

// 1. type consts, after the localhost-url const line
insert(LIB, "      const TAB_TYPE_LOCALHOST_URL = 'localhost-url'\n",
  "      const TAB_TYPE_HTML_FILE = 'html-file'\n      const TAB_TYPE_MARKDOWN_FILE = 'markdown-file'")
// 2. registry entries
insert(LIB, '        // seam(#7): add the file-preview tab type entries directly above this line',
  extract(lib7, 'File previews (ticket #7): one entry per type', 'seam(#7): add the file-preview tab type entries'))
// 3. FilePreviewTab + renderer block, above the BottomPanel comment
insert(LIB, '      // ---------- Bottom Panel (ADR 0001) ----------',
  extract(lib7, 'file preview tabs (ticket #7)', 'Bottom Panel (ADR 0001)'))
// 4. picker items
insert(LIB, '            // seam(#7): add the HTML file and Markdown file picker items directly above this line',
  sliceAfter(lib7, "Preview a URL in an iframe')),", '// seam(#7): add the HTML file and Markdown file picker items'))
// 5. forms
insert(LIB, '          // seam(#7): add the HTML file and Markdown file path-entry forms directly above this line',
  sliceAfter(lib7, "'Open'))) : null,", '// seam(#7): add the HTML file and Markdown file path-entry forms'))
// 6. CSS
insert(LIB, '        // seam(#7): add file-preview styles directly above this line',
  sliceAfter(lib7, "'.rsb-menu-item:hover", '// seam(#7): add file-preview styles').split('\n').slice(1).join('\n'))
// 7. client result codec
insert(LIB, '    // seam(#7): add the client readFile result codec directly above this line',
  extract(lib7, 'ReadFileResultCodec = codec(', 'seam(#7): add the client readFile result codec'))
// 8. client manifest invocation
insert(LIB, '        // seam(#7): add the readFile invocation directly above this line',
  extract(lib7, "invocation('readFile'", 'seam(#7): add the readFile invocation'))
// 9. facade name
insert(LIB, "        // seam(#7): add 'readFile' directly above this line", "        'readFile',")
console.log('lib/client.js reconstructed')

// ---- dynamic twin ----
const dyn7 = readFileSync('/tmp/dyn7.js', 'utf8')
const DYN = 'dynamic/client.js'
insert(DYN, "    const TAB_TYPE_LOCALHOST_URL = 'localhost-url'\n",
  "    const TAB_TYPE_HTML_FILE = 'html-file'\n    const TAB_TYPE_MARKDOWN_FILE = 'markdown-file'")
insert(DYN, '      // seam(#7): add the file-preview tab type entries directly above this line',
  extract(dyn7, 'File previews (ticket #7): one entry per type', 'seam(#7): add the file-preview tab type entries'))
insert(DYN, '    // ---------- Bottom Panel (ADR 0001) ----------',
  extract(dyn7, 'file preview tabs (ticket #7)', 'Bottom Panel (ADR 0001)'))
insert(DYN, '          // seam(#7): add the HTML file and Markdown file picker items directly above this line',
  sliceAfter(dyn7, "Preview a URL in an iframe')),", '// seam(#7): add the HTML file and Markdown file picker items'))
insert(DYN, '        // seam(#7): add the HTML file and Markdown file path-entry forms directly above this line',
  sliceAfter(dyn7, "'Open'))) : null,", '// seam(#7): add the HTML file and Markdown file path-entry forms'))
insert(DYN, '      // seam(#7): add file-preview styles directly above this line',
  sliceAfter(dyn7, "'.rsb-menu-item:hover", '// seam(#7): add file-preview styles').split('\n').slice(1).join('\n'))
console.log('dynamic/client.js reconstructed')
