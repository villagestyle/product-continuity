#!/usr/bin/env node
// Independent live-server boundary tests; no real project materials.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { makeAcceptanceState, ACCEPTANCE_TARGET } from './acceptance-fixtures.mjs';

function rawRequest(port, bytes, timeout = 15000) {
  return new Promise((resolveResponse, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Raw HTTP response timed out')); }, timeout);
    socket.on('connect', () => { socket.write(bytes); });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('end', () => {
      clearTimeout(timer);
      const response = Buffer.concat(chunks).toString('utf8');
      const status = Number(response.match(/^HTTP\/1\.[01] (\d+)/)?.[1] || 0);
      resolveResponse({ status, response });
    });
  });
}

export async function runSecurityAcceptance(outputDirectory) {
  const { startReviewService } = await import('../scripts/review-service.mjs');
  await mkdir(outputDirectory, { recursive: true });
  const directory = await mkdtemp(join(outputDirectory, 'security-state-'));
  const statePath = join(directory, 'project-state.json');
  await writeFile(statePath, JSON.stringify(makeAcceptanceState(), null, 2) + '\n');
  const originalBytes = await readFile(statePath);
  const service = await startReviewService(statePath, { port: 0 });
  const records = [];
  try {
    const navigation = await fetch(service.url + '/');
    assert.equal(navigation.status, 200, await navigation.text());
    const cookie = navigation.headers.get('set-cookie').split(';')[0];
    const stateResponse = await fetch(service.url + '/api/state', { headers: { Cookie: cookie } });
    const current = await stateResponse.json();
    assert.equal(stateResponse.status, 200, JSON.stringify(current));
    const preview = { projectId: current.state.project.id, action: 'defer', targetClaimId: ACCEPTANCE_TARGET, payload: { reason: 'needs_decision' }, expectedStateVersion: current.currentStateVersion, expectedDigest: current.currentDigest };
    const body = JSON.stringify(preview);
    const standard = { Cookie: cookie, Origin: service.url, 'Content-Type': 'application/json', 'X-Review-Action': '1' };
    async function check(label, path, expected, { method = 'POST', headers = standard, bytes = body } = {}) {
      const response = await fetch(service.url + path, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body: bytes }) });
      assert.equal(response.status, expected, label);
      assert.equal(response.headers.get('access-control-allow-origin'), null, label + ' must not advertise CORS');
      await response.arrayBuffer();
      records.push({ scenarioId: label, passed: true, status: response.status, exitCode: 0 });
    }
    for (const [label, change] of [
      ['H01/bad-origin', { Origin: 'http://evil.example' }],
      ['H01/null-origin', { Origin: 'null' }],
      ['H01/missing-action', { 'X-Review-Action': '' }],
      ['H01/cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
      ['H01/no-session', { Cookie: '' }],
    ]) await check(label, '/api/preview', 403, { headers: { ...standard, ...change } });
    const withoutOrigin = { ...standard };
    delete withoutOrigin.Origin;
    await check('H01/missing-origin', '/api/preview', 403, { headers: withoutOrigin });
    await check('H01/options', '/api/reviews', 405, { method: 'OPTIONS', bytes: undefined });
    await check('H01/wrong-method', '/api/state', 405);
    await check('H01/no-arbitrary-files', '/project-state.json', 404, { method: 'GET' });
    await check('H02/gzip', '/api/preview', 415, { headers: { ...standard, 'Content-Encoding': 'gzip' } });
    await check('H02/text', '/api/preview', 415, { headers: { ...standard, 'Content-Type': 'text/plain' } });
    await check('H02/invalid-json', '/api/preview', 400, { bytes: '{' });
    await check('H02/invalid-utf8', '/api/preview', 400, { bytes: Buffer.from([0x7b, 0xc3, 0x28, 0x7d]) });
    await check('H02/exact-64KiB', '/api/preview', 200, { bytes: ' '.repeat(65536 - Buffer.byteLength(body)) + body });
    await check('H02/over-64KiB', '/api/preview', 413, { bytes: ' '.repeat(65537 - Buffer.byteLength(body)) + body });
    const baseHeaders = ['Host: 127.0.0.1:' + service.port, 'Origin: ' + service.url, 'Cookie: ' + cookie, 'Content-Type: application/json', 'X-Review-Action: 1'];
    async function rawCheck(label, headers, bytes, expected, method = 'POST', path = '/api/preview') {
      const raw = Buffer.concat([Buffer.from(method + ' ' + path + ' HTTP/1.1\r\n' + headers.join('\r\n') + '\r\nConnection: close\r\n\r\n'), Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]);
      const response = await rawRequest(service.port, raw);
      assert.equal(response.status, expected, label);
      assert.ok(!/Access-Control-Allow-Origin:/i.test(response.response));
      records.push({ scenarioId: label, passed: true, status: response.status, exitCode: 0 });
    }
    await rawCheck('H01/trace', ['Host: 127.0.0.1:' + service.port], '', 405, 'TRACE', '/');
    await rawCheck('H01/bad-host', ['Host: localhost:' + service.port, ...baseHeaders.filter((line) => !line.startsWith('Host:')), 'Content-Length: ' + Buffer.byteLength(body)], body, 403);
    for (const [name, value] of [['Host', '127.0.0.1:' + service.port], ['Origin', service.url], ['Content-Type', 'application/json'], ['Cookie', cookie], ['X-Review-Action', '1']]) {
      await rawCheck('H01/duplicate-' + name.toLowerCase(), [...baseHeaders, name + ': ' + value, 'Content-Length: ' + Buffer.byteLength(body)], body, name === 'Host' ? 403 : 400);
    }
    const encoded = Buffer.from(' '.repeat(65537 - Buffer.byteLength(body)) + body);
    const chunked = Buffer.concat([Buffer.from(encoded.length.toString(16) + '\r\n'), encoded, Buffer.from('\r\n0\r\n\r\n')]);
    await rawCheck('H02/chunked-over-limit', [...baseHeaders, 'Transfer-Encoding: chunked'], chunked, 413);
    assert.deepEqual(await readFile(statePath), originalBytes, 'Security/preview requests must not change the source');
    const report = { kind: 'host-security-acceptance', generatedAt: new Date().toISOString(), passed: true, node: process.version, platform: process.platform, scenarios: records, sourceUnchanged: true, scope: 'Loopback request protection; not authentication against local attackers.' };
    await writeFile(join(outputDirectory, 'security-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally { await service.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runSecurityAcceptance(resolve(process.argv[2] || join(tmpdir(), 'product-continuity-acceptance')));
  console.log('SECURITY_ACCEPTANCE_OK: ' + result.scenarios.length + ' live boundary checks; source unchanged.');
}
