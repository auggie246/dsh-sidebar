#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// The Commit Graph's public row contract: refs keep their priority order,
// as many pills as the row width fits must render, and the hidden remainder
// stays a +N button whose click renders the full ordered ref popover. These
// source-level assertions are necessary because this plugin's browser half
// intentionally exports only its Cordis registration.
assert.match(source, /ref\.type === 'branch' \? 0[\s\S]*\/HEAD\$\//, 'refs must prioritize branches, remotes, symbolic HEAD, then tags')
assert.match(source, /refs\.slice\(0, shown\)\.map[\s\S]*'rsb-badge rsb-badge-' \+ r\.type/, 'every fitting ref must render as its typed pill')
assert.match(source, /offsetLeft \+ b\.offsetWidth/, 'pill fit must be measured against the row width')
assert.match(source, /new ResizeObserver\(refit\)[\s\S]*const n = measureRefFit|const n = measureRefFit[\s\S]*new ResizeObserver\(refit\)/, 'a resize must re-measure the live DOM and truncate, never hide a pill behind the author')
assert.match(source, /className: 'rsb-ref-overflow'[\s\S]*'\+' \+ extra/, 'hidden refs must collapse into a +N affordance')
assert.match(source, /const refList = refs\.map\(\(r\) => r\.name\)\.join\('\\n'\)[\s\S]*refList: refList/, 'hover/focus text must expose every ref')
assert.match(source, /className: 'rsb-ref-popover'[\s\S]*refPopover\.refs\.map/, 'clicking overflow must render the full ref popover')
assert.match(source, /\.rsb-grefs \{[^}]*overflow: hidden/, 'the ref pill row must clip, never wrap')
console.log('commit ref summary check passed')
