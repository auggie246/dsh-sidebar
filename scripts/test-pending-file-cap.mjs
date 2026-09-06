#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// The Git Status card's pending-commit contract: merge conflicts, staged,
// and unstaged rows share one scroll area that shows at most six file rows
// before it scrolls, so the card size stays fixed no matter how many files
// are pending. These source-level assertions are necessary because this
// plugin's browser half intentionally exports only its Cordis registration.

const sources = await Promise.all(
  ['lib/client.js', 'dynamic/client.js'].map(async (file) => ({
    file,
    source: await readFile(new URL('../' + file, import.meta.url), 'utf8'),
  })),
)

for (const { file, source } of sources) {
  assert.match(source, /const PF_MAX_ROWS = 6/, file + ': the pending cap must be six file rows')
  assert.match(source, /const pendingGroups = \[[\s\S]*'Merge Conflicts', data\.conflicts, 'conflicts'[\s\S]*'Staged Changes', data\.staged, 'staged'[\s\S]*'Changes', data\.unstaged, 'changes'[\s\S]*\]/, file + ': all three pending groups must share the capped scroll area')
  assert.match(source, /changeCount > PF_MAX_ROWS\s*\?\s*h\('div', \{ className: 'rsb-pending'/, file + ': the cap must apply only when more than six rows are pending')
  assert.match(source, /style: \{ maxHeight: pendingHeight\(PF_MAX_ROWS\) \+ 'px' \}/, file + ': the scroll cap must come from pendingHeight, not a viewport measure')
  assert.match(source, /const take = Math\.min\(g\[1\]\.length, n - seen\)/, file + ': pendingHeight must count rows group by group so no extra row peeks past the cap')
  assert.match(source, /height \+= PF_HEAD \+ take \* \(PF_ROW \+ PF_INNER_GAP\)/, file + ': pendingHeight must count exact row and head heights')
  assert.match(source, /\.rsb-pending \{[^}]*overflow-y: auto/, file + ': the pending area must scroll, never stretch the card')
  assert.match(source, /\.rsb-file \{[^}]*height: ' \+ PF_ROW \+ 'px; box-sizing: border-box/, file + ': file rows must carry the exact height the cap counts')
  assert.match(source, /\.rsb-group-head \{[^}]*height: ' \+ \(PF_HEAD - 4\) \+ 'px; box-sizing: border-box/, file + ': group heads must carry the exact height the cap counts')
  assert.match(source, /\.rsb-group \{[^}]*gap: ' \+ PF_INNER_GAP \+ 'px/, file + ': the row gap must come from the same constant the cap counts')
  assert.match(source, /\.rsb-pending \{[^}]*gap: ' \+ PF_GROUP_GAP \+ 'px/, file + ': the group gap must come from the same constant the cap counts')
}
console.log('pending file cap check passed')
