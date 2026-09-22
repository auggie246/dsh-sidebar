#!/usr/bin/env node
// Persistent-install check for the DSH Web profile.
//
// The host half mounts from a loader row, `{ id: sidebar, name: 'dsh-sidebar' }`.
// That row comes from the package's OWN bundle patch: `package.json` declares
// `dsh.bundle.patch`, and DSH applies that file for every entry of
// `dsh.profile.bundles`. The profile's own `cordis.patch.yml` is one extra user
// layer, applied after the bundles.
//
// So the row must appear in exactly one of the two layers. Repeating the insert
// in the profile patch gives the loader two entries with one id, and the loader
// refuses that with "duplicate loader entry id: sidebar" — the profile would not
// boot. This check therefore fails when the row is in neither layer, and also
// when it is in both.
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
const ROW = /id:\s*sidebar\s*\n\s*name:\s*['"]?dsh-sidebar['"]?/;

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
if (profile && !(profile.dsh?.profile?.bundles ?? []).includes('dsh-sidebar')) {
  failures.push('web profile does not list dsh-sidebar in dsh.profile.bundles, so its bundle patch never applies');
}

// The bundle layer: resolve the installed package and read the patch file its
// own manifest names.
const requireFromProfile = createRequire(packagePath);
let bundlePatchPath = '';
let bundlePatch = '';
try {
  const manifestPath = requireFromProfile.resolve('dsh-sidebar/package.json');
  const declared = JSON.parse(await readFile(manifestPath, 'utf8')).dsh?.bundle?.patch;
  if (typeof declared !== 'string' || declared === '') {
    failures.push(`${manifestPath} declares no dsh.bundle.patch, so the profile cannot compose the sidebar row`);
  } else {
    bundlePatchPath = join(dirname(manifestPath), declared);
    bundlePatch = await readFile(bundlePatchPath, 'utf8');
  }
} catch (error) {
  failures.push(`cannot read the installed dsh-sidebar bundle patch: ${error.message}`);
}

// The user layer: present on every profile, and the wrong home for this row.
let profilePatch = '';
try {
  profilePatch = await readFile(patchPath, 'utf8');
} catch (error) {
  failures.push(`cannot read ${patchPath}: ${error.message}`);
}

const layers = []
  .concat(bundlePatchPath && ROW.test(bundlePatch) ? [`the package bundle patch (${bundlePatchPath})`] : [])
  .concat(ROW.test(profilePatch) ? [`the profile patch file (${patchPath})`] : []);
if (layers.length === 0) {
  failures.push('no layer composes dsh-sidebar as sidebar: neither the package bundle patch nor the profile patch file holds the id: sidebar row');
}
if (layers.length > 1) {
  failures.push(`the id: sidebar row appears in more than one layer (${layers.join(' and ')}); the loader refuses a duplicate entry id and the profile would not boot`);
}

// The load check runs even when a layer is wrong: one run should report
// everything it can, not stop at the first problem.
try {
  await import(pathToFileURL(requireFromProfile.resolve('dsh-sidebar')).href);
} catch (error) {
  failures.push(`dsh-sidebar host entry cannot load from the web profile: ${error.message}`);
}

if (failures.length) {
  console.error('DSH Sidebar persistent-install check FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('DSH Sidebar persistent-install check passed.');
}
