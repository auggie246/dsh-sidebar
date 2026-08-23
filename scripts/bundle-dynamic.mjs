/**
 * Builds the single-file dynamic-plugin bundle from dynamic/host.js and
 * dynamic/client.js. Run after editing either file:
 *
 *   npm run bundle:dynamic
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const host = await readFile(join(root, 'dynamic/host.js'), 'utf8')
const client = await readFile(join(root, 'dynamic/client.js'), 'utf8')

const bundle = {
  kind: 'dsh-dynamic-cordis-plugin',
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  host,
  client,
}

const out = join(root, 'dynamic', 'dsh-git-sidebar.dynamic.json')
await writeFile(out, JSON.stringify(bundle, null, 2) + '\n')
console.log(`wrote ${out}`)
