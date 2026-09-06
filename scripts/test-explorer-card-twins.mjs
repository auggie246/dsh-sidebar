#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// The Explorer Card's cross-twin contract (issue #21): the composition
// package (lib/) and the dynamic bundle (dynamic/) must stay behaviorally
// in sync (docs/design-notes.md). These source-level assertions pin the
// seam both twins must carry: the Card Manifest entry, the ADR 0007
// pending-open store and its BottomPanel drain, the lazy listing RPC, the
// per-directory entry cap, and the tree's scroll cap. They are necessary
// because this plugin's browser half intentionally exports only its Cordis
// registration.

const sources = await Promise.all(
  ['lib/client.js', 'dynamic/client.js'].map(async (file) => ({
    file,
    source: await readFile(new URL('../' + file, import.meta.url), 'utf8'),
  })),
)

for (const { file, source } of sources) {
  assert.match(source, /\{ id: 'explorer', title: 'Explorer', order: 30, render: ExplorerCard \}/, file + ': the Explorer must join the Card Manifest last, visible by default')
  assert.match(source, /const pendingOpenStore = createStore\(\[\]\)/, file + ': the ADR 0007 pending-open store must exist at plugin scope')
  assert.match(source, /function requestPreview\(path\) \{/, file + ': the file-select seam must be a named function')
  assert.match(source, /pendingOpenStore\.set\(pendingOpenStore\.get\(\)\.concat\(\[\{ path: p \}\]\)\)/, file + ': a file select must enqueue one path request')
  assert.match(source, /function drainPendingOpens\(\) \{/, file + ': the Panel must own a drain for the pending-open store')
  assert.match(source, /pendingOpenStore\.set\(\[\]\)/, file + ': the drain must empty the store it read')
  assert.match(source, /return pendingOpenStore\.subscribe\(\(\) => drainPendingOpens\(\)\)/, file + ': the drain must run on mount and on every store change')
  assert.match(source, /const TREE_ROW = 24/, file + ': tree rows must carry the exact height the scroll cap counts')
  assert.match(source, /\.rsb-tree \{[^}]*overflow-y: auto/, file + ': the tree must scroll, never stretch the card')
  assert.match(source, /\.rsb-tree-row \{[^}]*height: ' \+ TREE_ROW \+ 'px; box-sizing: border-box/, file + ': the row height must come from the TREE_ROW constant')
  assert.match(source, /previewTypeFor/, file + ': the preview type must follow the file extension (.md renders as Markdown)')
}

// The composition client mounts the Typert remote and a call facade.
{
  const { source } = sources.find((s) => s.file === 'lib/client.js')
  assert.match(source, /invocation\('listDir', \[CWD, param\('path', PathParam\)\], result\(DirListResultCodec\)\)/, 'lib/client.js: the TYPERT_REMOTE mount must carry the listDir invocation')
  assert.match(source, /'readFile', 'listDir',/, 'lib/client.js: the git facade must expose listDir beside readFile')
  assert.match(source, /const DirListResultCodec = codec\(`\$\{PACKAGE\}\/DirListResult`/, 'lib/client.js: the client-side codec mirror must exist')
}

// The dynamic client calls the host through the package-private channel.
{
  const { source } = sources.find((s) => s.file === 'dynamic/client.js')
  assert.match(source, /host\.call\('listDir', withCwd\(\{ path: p \}\)\)/, 'dynamic/client.js: the Explorer must call listDir through the package-private channel')
}

// The host twins: same confinement walk, same entry cap, same one-command
// GNU find listing.
const hostSources = await Promise.all(
  ['lib/index.js', 'dynamic/host.js'].map(async (file) => ({
    file,
    source: await readFile(new URL('../' + file, import.meta.url), 'utf8'),
  })),
)
for (const { file, source } of hostSources) {
  assert.match(source, /const LIST_DIR_LIMIT = 1000/, file + ': one listing must cap at 1000 entries')
  assert.match(source, /listDir/, file + ': the host must serve the listDir RPC')
  assert.match(source, /-maxdepth 1 -mindepth 1 -printf/, file + ': the listing must be one GNU find command (the shell service spawns commands directly, no pipes)')
  assert.match(source, /kindChar === 'd' \? 'dir' : kindChar === 'l' \? 'link' : 'file'/, file + ': find type chars must map onto the file/dir/link kinds')
  assert.match(source, /entries\.sort\(\(a, b\) => \{[\s\S]*?if \(ad !== bd\) return ad - bd/, file + ': entries must sort folders first BEFORE the cap slices, so the kept slice is the sorted-first 1000')
}
{
  const { source } = hostSources.find((s) => s.file === 'lib/index.js')
  assert.match(source, /async listDir\(cwdArg, pathArg\) \{/, 'lib/index.js: the controller must expose listDir beside readFile')
  const remote = await readFile(new URL('../lib/remote.js', import.meta.url), 'utf8')
  assert.match(remote, /invocation\('listDir', \[CWD, param\('path', PathParam\)\], result\(DirListResultCodec\)\)/, 'lib/remote.js: the host manifest must declare the listDir invocation')
  assert.match(remote, /'readFile', 'listDir',/, 'lib/remote.js: the gateway must mark listDir as a client-mounted method')
}
{
  const { source } = hostSources.find((s) => s.file === 'dynamic/host.js')
  assert.match(source, /harness\.handle\('listDir'/, 'dynamic/host.js: the dynamic host must serve listDir through harness.handle')
}
console.log('explorer twins check passed')
