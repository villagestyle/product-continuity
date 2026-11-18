/**
 * HTTP-only test helpers for review-service.test.mjs.
 *
 * Everything here talks to a loopback listener created by the test itself.
 * No product endpoint, repository, or real project state is touched.
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function makeTempDir(prefix = 'pc-http-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeStateFixture(state, { tempDir } = {}) {
  const dir = tempDir ?? (await makeTempDir());
  const statePath = path.join(dir, 'project-state.json');
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fsp.writeFile(statePath, bytes);
  return { dir, statePath, bytes, digest: digestBytes(bytes) };
}

export async function readState(statePath) {
  const bytes = await fsp.readFile(statePath);
  return {
    bytes,
    text: bytes.toString('utf8'),
    digest: digestBytes(bytes),
    state: JSON.parse(bytes.toString('utf8')),
  };
}

export function parseSetCookie(value) {
  if (typeof value !== 'string' || value === '') return null;
  const first = value.split(';')[0];
  const separator = first.indexOf('=');
  if (separator < 0) return null;
  return {
    raw: value,
    name: first.slice(0, separator).trim(),
    value: first.slice(separator + 1).trim(),
  };
}

export async function getPageSession(service) {
  const response = await fetch(`${service.url}/`, { redirect: 'manual' });
  const html = await response.text();
  const setCookies = response.headers.getSetCookie?.() ?? [
    response.headers.get('set-cookie'),
  ].filter(Boolean);
  const cookie = parseSetCookie(setCookies[0]);
  return {
    status: response.status,
    headers: response.headers,
    html,
    setCookies,
    cookie,
    cookieHeader: cookie ? `${cookie.name}=${cookie.value}` : null,
  };
}

function appendHeaders(lines, headers) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
}

export function buildRawRequest({
  method = 'GET',
  path: requestPath = '/',
  host,
  headers = {},
  body,
  connection = 'close',
}) {
  const lines = [`${method} ${requestPath} HTTP/1.1`];
  if (host !== undefined) lines.push(`Host: ${host}`);
  appendHeaders(lines, headers);
  if (connection) lines.push(`Connection: ${connection}`);
  let payload = Buffer.alloc(0);
  if (body !== undefined) {
    payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const hasLength = Object.keys(headers).some(
      (name) => name.toLowerCase() === 'content-length',
    );
    const hasTransfer = Object.keys(headers).some(
      (name) => name.toLowerCase() === 'transfer-encoding',
    );
    if (!hasLength && !hasTransfer) lines.push(`Content-Length: ${payload.byteLength}`);
  }
  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), payload]);
}

export function parseRawResponse(buffer) {
  const separator = buffer.indexOf(Buffer.from('\r\n\r\n'));
  if (separator < 0) {
    return {
      status: 0,
      headers: {},
      body: buffer,
      text: buffer.toString('utf8'),
      raw: buffer,
    };
  }
  const head = buffer.subarray(0, separator).toString('latin1');
  const body = buffer.subarray(separator + 4);
  const lines = head.split('\r\n');
  const status = Number((lines[0] ?? '').split(/\s+/)[1] ?? 0);
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  let text = body.toString('utf8');
  const length = Number(headers['content-length']);
  if (Number.isInteger(length) && body.length >= length) {
    text = body.subarray(0, length).toString('utf8');
  }
  return { status, headers, body, text, raw: buffer };
}

export function rawRequest(port, requestBytes, { timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks = [];
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error && chunks.length === 0) {
        reject(error);
      } else {
        resolve(parseRawResponse(Buffer.concat(chunks)));
      }
    };
    const timer = setTimeout(() => finish(new Error('raw request timed out')), timeout);
    socket.on('connect', () => socket.write(requestBytes));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('error', (error) => finish(error));
  });
}

export function httpJson(
  port,
  requestPath,
  { method = 'GET', headers = {}, body, timeout = 6000 } = {},
) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      if (!Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'content-length')) {
        requestHeaders['Content-Length'] = String(payload.byteLength);
      }
    }
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method,
        headers: requestHeaders,
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // The caller can inspect text.
          }
          resolve({ status: response.statusCode, headers: response.headers, text, json });
        });
      },
    );
    request.setTimeout(timeout, () => {
      request.destroy(new Error('httpJson timed out'));
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export function rawCookieRequest(port, { cookie, host, path: requestPath = '/api/state', origin, extraHeaders } = {}) {
  return rawRequest(
    port,
    buildRawRequest({
      method: 'GET',
      path: requestPath,
      host,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...extraHeaders,
      },
    }),
  );
}
