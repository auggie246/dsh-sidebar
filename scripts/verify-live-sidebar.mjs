#!/usr/bin/env node
const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
const response = await fetch(baseUrl);
const html = await response.text();

if (!response.ok) {
  console.error(`DSH Sidebar live check FAILED: ${baseUrl} returned HTTP ${response.status}`);
  process.exit(1);
}

const bootMatch = html.match(/window\.__DSH_BOOT__\s*=\s*(\{.*?\})<\/script>/s);
if (!bootMatch) {
  console.error('DSH Sidebar live check FAILED: DSH boot manifest was not found.');
  process.exit(1);
}

let boot;
try {
  boot = JSON.parse(bootMatch[1]);
} catch (error) {
  console.error(`DSH Sidebar live check FAILED: boot manifest is invalid JSON: ${error.message}`);
  process.exit(1);
}

const sidebar = boot.entries?.find((entry) => entry.id === 'dsh-sidebar');
if (!sidebar?.url) {
  console.error('DSH Sidebar live check FAILED: dsh-sidebar is absent from the browser boot manifest.');
  process.exit(1);
}

const bundleResponse = await fetch(new URL(sidebar.url, baseUrl));
const bundle = await bundleResponse.text();
if (!bundleResponse.ok || !bundle.includes("id: 'dsh-sidebar'")) {
  console.error('DSH Sidebar live check FAILED: the advertised browser bundle is unavailable or invalid.');
  process.exit(1);
}

console.log(`DSH Sidebar live check passed: ${sidebar.url}`);
