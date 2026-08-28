#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const profileDir = process.env.DSH_WEB_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'web');
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedSpecs = process.env.DSH_SIDEBAR_SPEC
  ? [process.env.DSH_SIDEBAR_SPEC]
  : [`file:${workspaceRoot}`, `link:${workspaceRoot}`];
const packagePath = join(profileDir, 'package.json');
const patchPath = join(profileDir, 'cordis.patch.yml');

const failures = [];
let profile;
try {
  profile = JSON.parse(await readFile(packagePath, 'utf8'));
} catch (error) {
  failures.push(`cannot read ${packagePath}: ${error.message}`);
}

const sidebarDependency = profile?.dependencies?.['dsh-sidebar'];
if (!expectedSpecs.includes(sidebarDependency)) {
  failures.push(`web profile does not depend on dsh-sidebar from this workspace (expected one of: ${expectedSpecs.join(', ')})`);
}

let patch = '';
try {
  patch = await readFile(patchPath, 'utf8');
} catch (error) {
  failures.push(`cannot read ${patchPath}: ${error.message}`);
}

if (!/id:\s*sidebar\s*\n\s*name:\s*['"]dsh-sidebar['"]/.test(patch)) {
  failures.push('web profile patch does not compose dsh-sidebar as sidebar');
}

if (failures.length === 0) {
  try {
    const requireFromProfile = createRequire(packagePath);
    const sidebarEntrypoint = requireFromProfile.resolve('dsh-sidebar');
    await import(pathToFileURL(sidebarEntrypoint).href);
  } catch (error) {
    failures.push(`dsh-sidebar host entry cannot load from the web profile: ${error.message}`);
  }
}

if (failures.length) {
  console.error('DSH Sidebar persistent-install check FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('DSH Sidebar persistent-install check passed.');
}
