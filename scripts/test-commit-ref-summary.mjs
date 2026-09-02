#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// The Commit Graph's public row contract: a primary branch label stays in the
// row, overflow is a button, and the full ordered ref set is available to its
// tooltip/popover. These source-level assertions are necessary because this
// plugin's browser half intentionally exports only its Cordis registration.
assert.match(source, /ref\.type === 'branch' \? 0[\s\S]*\/HEAD\$\//, 'refs must prioritize branches, remotes, symbolic HEAD, then tags')
assert.match(source, /const primaryRef = refs\[0\]/, 'the highest-priority ref must be the visible ref')
assert.match(source, /className: 'rsb-ref-overflow'[\s\S]*'\+' \+ \(refs.length - 1\)/, 'multiple refs must collapse into a +N affordance')
assert.match(source, /const refList = refs\.map\(\(r\) => r\.name\)\.join\('\\n'\)[\s\S]*title: refList/, 'hover/focus text must expose every ref')
assert.match(source, /className: 'rsb-ref-popover'[\s\S]*refPopover\.refs\.map/, 'clicking overflow must render the full ref popover')
assert.match(source, /\.rsb-ref-summary \{[^}]*max-width: 120px/, 'the visible ref slot must be capped at 120px')
console.log('commit ref summary check passed')
