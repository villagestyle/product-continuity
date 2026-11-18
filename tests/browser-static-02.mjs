#!/usr/bin/env node
// Host acceptance for the 0.2 read-only map; no real product files are read.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { renderMap } from '../scripts/render-map.mjs';
import { launchBrowser } from './browser-harness.mjs';

const executable = process.argv[2];
const root = resolve(process.argv[3] || tmpdir());
if (!executable) throw new Error('Usage: node tests/browser-static-02.mjs <chromium> [temporary-directory]');
const directory = await mkdtemp(join(root, 'continuity-static-02-'));
const browser = await launchBrowser(executable, root);
try {
  const state = JSON.parse(await readFile(new URL('../examples/demo-project-state-0.2.json', import.meta.url), 'utf8'));
  const page = await browser.newPage();
  await page.resize(1440);
  const file = join(directory, 'map.html');
  await writeFile(file, renderMap(state), 'utf8');
  await page.navigate(pathToFileURL(file).href);
  assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'), state.nodes.length);
  await page.click('[data-node-id="commitment:note-limit"] .graph-node-select');
  const duplicates = await page.evaluate('(()=>{const seen=new Set();return [...document.querySelectorAll("[id]")].map(e=>e.id).filter(id=>{if(seen.has(id))return true;seen.add(id);return false;});})()');
  assert.deepEqual(duplicates, [], 'Inspector clones must not duplicate claim or proposal IDs');
  for (const width of [320, 375, 720]) {
    await page.resize(width);
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Horizontal overflow at ' + width);
  }
  const html = await page.evaluate('document.documentElement.outerHTML');
  assert.ok(!html.includes('/api/reviews'), 'Static map has no write endpoint');
  const requests = browser.events.filter((event) => event.method === 'Network.requestWillBeSent' && /^https?:/.test(event.params.request.url));
  const errors = browser.events.filter((event) => event.method === 'Runtime.exceptionThrown');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log('BROWSER_STATIC_02_OK: claim inspector ID uniqueness; 320/375/720px; no write endpoint; 0 runtime errors; 0 HTTP requests.');
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
