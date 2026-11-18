// Optional Chromium driver for host acceptance. Uses Node's built-in WebSocket.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function launchBrowser(executable, temporaryRoot) {
  const directory = await mkdtemp(join(resolve(temporaryRoot), 'continuity-browser-'));
  const process = spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-port=0',
    '--user-data-dir=' + join(directory, 'profile'), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  try {
    const endpoint = await new Promise((resolveEndpoint, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chromium debugging endpoint timed out')), 20000);
      process.once('error', (error) => { clearTimeout(timeout); reject(error); });
      process.once('exit', (code) => { clearTimeout(timeout); reject(new Error('Chromium exited: ' + code)); });
      let stderr = '';
      process.stderr.on('data', (chunk) => {
        stderr += chunk;
        const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timeout); resolveEndpoint(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolveOpen, reject) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    const events = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) { events.push(message); return; }
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timeout);
      if (message.error) call.reject(new Error(JSON.stringify(message.error)));
      else call.resolve(message.result);
    });
    function send(method, params = {}, sessionId) {
      return new Promise((resolveCall, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
        pending.set(id, { resolve: resolveCall, reject, timeout });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
    async function newPage() {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await send(method, {}, sessionId);
      const pageSend = (method, params = {}) => send(method, params, sessionId);
      async function evaluate(expression) {
        const result = await pageSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      }
      async function waitFor(expression, timeout = 12000) {
        return evaluate(`new Promise((resolve,reject)=>{const start=Date.now();function check(){try{const value=(${expression});if(value){resolve(value);return;}}catch{}if(Date.now()-start>${timeout}){reject(new Error('Condition timed out'));return;}setTimeout(check,25);}check();})`);
      }
      return {
        targetId, sessionId, send: pageSend, evaluate, waitFor,
        async navigate(url) {
          await pageSend('Page.navigate', { url });
          await waitFor('document.readyState === "complete"');
          await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        },
        async click(selector) {
          await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing control');element.click();})()`);
        },
        async type(selector, value) {
          await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing field');element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        },
        async key(key, code = key, modifiers = 0) {
          const virtualKeys = { Enter: 13, Escape: 27, Tab: 9, ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Delete: 46, Home: 36, End: 35 };
          const windowsVirtualKeyCode = virtualKeys[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
          const text = key === 'Enter' ? '\r' : key.length === 1 && !modifiers ? key : undefined;
          await pageSend('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode, ...(text ? { text } : {}) });
          await pageSend('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode });
        },
        async resize(width, height = 900, mobile = false) {
          await pageSend('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
          await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        },
        async screenshot(path) {
          const { data } = await pageSend('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          await writeFile(path, Buffer.from(data, 'base64'));
        },
        async close() { await send('Target.closeTarget', { targetId }); },
      };
    }
    return {
      directory, events, send, newPage,
      async close() {
        try { await send('Browser.close'); } catch { /* A closed browser has no further work. */ }
        socket.close();
        if (process.exitCode === null) {
          await new Promise((resolveExit) => { process.once('exit', resolveExit); process.kill(); });
        }
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      },
    };
  } catch (error) {
    socket?.close();
    if (process.exitCode === null) {
      await new Promise((resolveExit) => { process.once('exit', resolveExit); process.kill(); });
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw error;
  }
}
