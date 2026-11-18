import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LOCK_SUFFIX,
  StoreError,
  acquireStateLocks,
  canonicalizeStatePath,
  createIoAdapter,
  openStateStore,
  releaseStateLocks,
  sha256Bytes,
} from '../scripts/state-store.mjs';
import {
  deferRequest,
  makeFakeDomain,
  makeStoreState,
  makeTempDir,
  previewDeferRequest,
  uuid,
  writeStateFile,
} from './store-fixtures.mjs';

const now = '2026-01-02T00:00:00.000Z';
const clock = () => new Date(now);

async function withTempDir(fn) {
  const dir = await makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeIo(overrides) {
  return createIoAdapter(overrides);
}

test('same file, relative path and symlink alias share one lock; different files do not', async () => {
  await withTempDir(async (dir) => {
    const { statePath } = await writeStateFile(dir, makeStoreState());
    const store = await openStateStore(statePath, { domain: makeFakeDomain() });
    try {
      const lockRecord = JSON.parse(await readFile(`${statePath}${LOCK_SUFFIX}`, 'utf8'));
      assert.equal(typeof lockRecord.token, 'string');
      assert.equal(lockRecord.pid, process.pid);
      assert.equal(typeof lockRecord.host, 'string');
      assert.equal(lockRecord.statePath, statePath);
      assert.equal(typeof lockRecord.startedAt, 'string');
      assert.equal(JSON.stringify(store.getSnapshot()).includes(lockRecord.token), false);

      await expectCode(openStateStore(statePath, { domain: makeFakeDomain() }), 'lock_held');

      const relative = path.relative(process.cwd(), statePath);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        await expectCode(openStateStore(relative, { domain: makeFakeDomain() }), 'lock_held');
      }

      const alias = path.join(dir, 'alias-state.json');
      try {
        await symlink(statePath, alias);
        await expectCode(openStateStore(alias, { domain: makeFakeDomain() }), 'lock_held');
      } catch (error) {
        if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
        // Windows without symlink privilege: the same-file lock is already
        // covered by the exact path check above.
      }

      const second = await writeStateFile(dir, makeStoreState(), 'second-state.json');
      const secondStore = await openStateStore(second.statePath, { domain: makeFakeDomain() });
      await secondStore.close();
    } finally {
      await store.close();
    }
  });
});

test('a replaced lock token is not deleted by close and stops writes', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes } = await writeStateFile(dir, makeStoreState());
    const store = await openStateStore(statePath, { domain: makeFakeDomain() });
    const lockPath = `${statePath}${LOCK_SUFFIX}`;
    const foreignLock = `${JSON.stringify({
      version: 1,
      token: 'foreign-token',
      pid: 424242,
      host: 'foreign-host',
      statePath,
      startedAt: now,
    })}\n`;
    await writeFile(lockPath, foreignLock);

    const request = deferRequest({
      projectId: 'project:store-test',
      stateVersion: 1,
      digest: sha256Bytes(bytes),
      idempotencyKey: uuid(1),
    });
    await expectCode(store.submitReview(request), 'lock_lost');
    assert.deepEqual(await readFile(statePath), bytes, 'no state bytes may be written after lock loss');
    assert.equal(store.getSnapshot().writable, false);
    assert.equal(store.getSnapshot().readOnlyReason, 'lock_lost');

    const close = await store.close();
    assert.equal(close.released, false);
    assert.equal(await readFile(lockPath, 'utf8'), foreignLock, 'a foreign lock token must survive close');
  });
});

test('valid external format or content changes stop writes and are reported', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const store = await openStateStore(statePath, { domain: makeFakeDomain() });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(2),
    });
    const reformatted = `${JSON.stringify(state, null, 4)}\n`;
    await writeFile(statePath, reformatted);

    await expectCode(store.submitReview(request), 'external_modification');
    assert.equal(await readFile(statePath, 'utf8'), reformatted);
    assert.deepEqual(await readFile(statePath), Buffer.from(reformatted));
    assert.notDeepEqual(await readFile(statePath), bytes);
    assert.equal(store.getSnapshot().writable, false);
    assert.equal(store.getSnapshot().readOnlyReason, 'external_modification');

    const snapshot = await store.read();
    assert.equal(snapshot.writable, false);
    assert.equal(snapshot.fileDigest, sha256Bytes(Buffer.from(reformatted)));
    await store.close();
  });
});

test('idempotent retries replay before stale checks, across close and reopen', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const domain = makeFakeDomain();
    let store = await openStateStore(statePath, { domain, clock });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(3),
    });

    const first = await store.submitReview(request);
    assert.equal(first.outcome, 'saved');
    assert.equal(first.commitStatus, 'verified');
    assert.equal(first.resultingStateVersion, 2);
    const committed = await readFile(statePath);
    assert.notDeepEqual(committed, bytes);

    const retry = await store.submitReview(request);
    assert.equal(retry.outcome, 'replayed');
    assert.equal(retry.commitStatus, 'verified');
    assert.equal(retry.reviewId, first.reviewId);
    assert.equal(retry.resultingStateVersion, 2);
    assert.equal(retry.currentStateVersion, 2);
    assert.deepEqual(await readFile(statePath), committed, 'replay must not write');
    assert.equal(store.getSnapshot().state.reviews.length, 1);
    await store.close();

    store = await openStateStore(statePath, { domain: makeFakeDomain(), clock });
    const restartRetry = await store.submitReview(request);
    assert.equal(restartRetry.outcome, 'replayed');
    assert.equal(restartRetry.reviewId, first.reviewId);
    assert.equal(restartRetry.currentStateVersion, 2);
    assert.deepEqual(await readFile(statePath), committed, 'restart replay must not write');
    await store.close();
  });
});

test('same key with a different command conflicts without leaking the old payload', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, digest } = await writeStateFile(dir, state);
    const store = await openStateStore(statePath, { domain: makeFakeDomain(), clock });
    const key = uuid(4);
    const firstRequest = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: key,
      note: 'old secret body',
    });
    await store.submitReview(firstRequest);
    const committed = await readFile(statePath);

    const conflicting = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: key,
      note: 'different body',
    });
    try {
      await store.submitReview(conflicting);
      assert.fail('expected an idempotency conflict');
    } catch (error) {
      assert.equal(error.code, 'idempotency_conflict');
      assert.equal(error.status, 409);
      assert.equal(error.commitStatus, 'not_committed');
      assert.equal(error.message.includes('old secret body'), false);
      assert.equal(error.message.includes('different body'), false);
    }
    assert.deepEqual(await readFile(statePath), committed);
    assert.equal(store.getSnapshot().state.reviews.length, 1);
    await store.close();
  });
});

test('the serial queue rejects overflow with queue_full without starting extra actions', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, digest } = await writeStateFile(dir, state);
    const gate = deferred();
    const domain = makeFakeDomain({ previewGate: gate.promise });
    const store = await openStateStore(statePath, { domain, clock, maxQueue: 16 });
    const request = previewDeferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
    });
    const results = [];
    for (let index = 0; index < 18; index += 1) {
      results.push(store.preview(request).then(() => 'ok', (error) => error.code));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resolve();
    const settled = await Promise.all(results);
    assert.equal(settled.filter((value) => value === 'queue_full').length, 2);
    assert.equal(settled.filter((value) => value === 'ok').length, 16);
    await store.close();
  });
});

test('replacement failure preserves the old state and names a pending temporary file', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const io = fakeIo({
      async rename(from, to) {
        if (to === statePath && from.endsWith('.pending')) {
          const error = new Error('injected rename failure');
          error.code = 'EIO';
          throw error;
        }
        return (await import('node:fs/promises')).rename(from, to);
      },
    });
    const store = await openStateStore(statePath, { domain: makeFakeDomain(), clock, fs: io });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(5),
    });
    try {
      await store.submitReview(request);
      assert.fail('expected replace_failed_preserved');
    } catch (error) {
      assert.equal(error.code, 'replace_failed_preserved');
      assert.equal(error.commitStatus, 'not_committed');
      assert.ok(error.details.backupPath);
      assert.ok(error.details.temporaryPath.endsWith('.pending'));
      assert.equal((await readFile(error.details.backupPath)).equals(bytes), true);
      assert.equal((await readFile(error.details.temporaryPath)).length > 0, true);
    }
    assert.deepEqual(await readFile(statePath), bytes);
    assert.equal(store.getSnapshot().stateVersion, 1);
    await store.close();
  });
});

test('temporary write failure aborts before backup or replacement', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const fsPromises = await import('node:fs/promises');
    const io = fakeIo({
      async open(target, flags, mode) {
        if (target.startsWith(`${statePath}.`) && target.endsWith('.pending')) {
          const error = new Error('injected temporary write failure');
          error.code = 'EIO';
          throw error;
        }
        return fsPromises.open(target, flags, mode);
      },
    });
    const store = await openStateStore(statePath, { domain: makeFakeDomain(), clock, fs: io });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(15),
    });
    await expectCode(store.submitReview(request), 'prepare_failed');
    assert.deepEqual(await readFile(statePath), bytes);
    assert.equal((await readFile(`${statePath}${LOCK_SUFFIX}`, 'utf8')).length > 0, true);
    await store.close();
  });
});

test('a lock replaced immediately before rename stops the replacement', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const lockPath = `${statePath}${LOCK_SUFFIX}`;
    const foreignLock = `${JSON.stringify({
      version: 1,
      token: 'foreign-token-before-rename',
      pid: 515151,
      host: 'foreign-host',
      statePath,
      startedAt: now,
    })}\n`;
    let replaced = false;
    const store = await openStateStore(statePath, {
      domain: makeFakeDomain(),
      clock,
      hooks: {
        async beforeRename() {
          if (!replaced) {
            replaced = true;
            await writeFile(lockPath, foreignLock);
          }
        },
      },
    });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(16),
    });
    await expectCode(store.submitReview(request), 'lock_lost');
    assert.deepEqual(await readFile(statePath), bytes);
    assert.equal(store.getSnapshot().writable, false);
    const close = await store.close();
    assert.equal(close.released, false);
    assert.equal(await readFile(lockPath, 'utf8'), foreignLock);
  });
});

test('an external write injected by beforeRename is preserved and stops the replacement', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, digest } = await writeStateFile(dir, state);
    const externalBytes = Buffer.from(`${JSON.stringify({ ...state, stateVersion: 8 }, null, 2)}\n`, 'utf8');
    let injected = false;
    const store = await openStateStore(statePath, {
      domain: makeFakeDomain(),
      clock,
      hooks: {
        async beforeRename() {
          if (!injected) {
            injected = true;
            await writeFile(statePath, externalBytes);
          }
        },
      },
    });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(22),
    });
    await expectCode(store.submitReview(request), 'external_modification');
    assert.deepEqual(await readFile(statePath), externalBytes, 'the injected external bytes must survive');
    assert.equal(store.getSnapshot().writable, false);
    assert.equal(store.getSnapshot().readOnlyReason, 'external_modification');
    await store.close();
  });
});

test('beforeRename external edits are re-checked on rename retries', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, digest } = await writeStateFile(dir, state);
    const externalBytes = Buffer.from(`${JSON.stringify({ ...state, stateVersion: 7 }, null, 2)}\n`, 'utf8');
    const fsPromises = await import('node:fs/promises');
    let attempts = 0;
    let injected = false;
    const store = await openStateStore(statePath, {
      domain: makeFakeDomain(),
      clock,
      hooks: {
        async beforeRename({ attempt }) {
          if (attempt === 2 && !injected) {
            injected = true;
            await writeFile(statePath, externalBytes);
          }
        },
      },
      fs: createIoAdapter({
        async rename(from, to) {
          if (to === statePath && from.endsWith('.pending')) {
            attempts += 1;
            if (attempts === 1) {
              const error = new Error('injected busy target');
              error.code = 'EPERM';
              throw error;
            }
          }
          return fsPromises.rename(from, to);
        },
      }),
    });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(23),
    });
    await expectCode(store.submitReview(request), 'external_modification');
    assert.equal(attempts, 1, 'rename must not be attempted again after the external edit');
    assert.deepEqual(await readFile(statePath), externalBytes);
    assert.equal(store.getSnapshot().writable, false);
    await store.close();
  });
});

test('a beforeRename hook failure is a not-committed prepare failure', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const store = await openStateStore(statePath, {
      domain: makeFakeDomain(),
      clock,
      hooks: {
        beforeRename() {
          throw new Error('injected beforeRename hook failure');
        },
      },
    });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(17),
    });
    try {
      await store.submitReview(request);
      assert.fail('expected prepare_failed');
    } catch (error) {
      assert.equal(error.code, 'prepare_failed');
      assert.equal(error.commitStatus, 'not_committed');
      assert.ok(error.details.backupPath);
    }
    assert.deepEqual(await readFile(statePath), bytes);
    assert.equal(store.getSnapshot().writable, true);
    await store.close();
  });
});

test('backup failure aborts before replacement and marks the temporary file failed', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const store = await openStateStore(statePath, {
      domain: makeFakeDomain(),
      clock,
      hooks: {
        beforeBackupWrite() {
          throw new Error('injected backup failure');
        },
      },
    });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(6),
    });
    try {
      await store.submitReview(request);
      assert.fail('expected backup_failed');
    } catch (error) {
      assert.equal(error.code, 'backup_failed');
      assert.equal(error.commitStatus, 'not_committed');
      assert.ok(error.details.temporaryPath.endsWith('.failed'));
      assert.equal((await readFile(error.details.temporaryPath)).length > 0, true);
    }
    assert.deepEqual(await readFile(statePath), bytes);
    await store.close();
  });
});

test('Windows-style transient rename errors are retried with fresh checks', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, digest } = await writeStateFile(dir, state);
    const fsPromises = await import('node:fs/promises');
    let attempts = 0;
    const io = fakeIo({
      async rename(from, to) {
        if (to === statePath && from.endsWith('.pending')) {
          attempts += 1;
          if (attempts <= 2) {
            const error = new Error('injected busy file');
            error.code = 'EPERM';
            throw error;
          }
        }
        return fsPromises.rename(from, to);
      },
    });
    const store = await openStateStore(statePath, { domain: makeFakeDomain(), clock, fs: io });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(7),
    });
    const result = await store.submitReview(request);
    assert.equal(result.outcome, 'saved');
    assert.equal(result.commitStatus, 'verified');
    assert.equal(result.renameAttempts, 3);
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.stateVersion, 2);
    assert.equal(snapshot.state.reviews.length, 1);
    await store.close();
  });
});

test('a retry re-checks the target and stops when an external edit appears', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, digest } = await writeStateFile(dir, state);
    const fsPromises = await import('node:fs/promises');
    const externalBytes = Buffer.from(`${JSON.stringify({ ...state, stateVersion: 9 }, null, 2)}\n`, 'utf8');
    let injected = false;
    const io = fakeIo({
      async rename(from, to) {
        if (to === statePath && from.endsWith('.pending') && !injected) {
          injected = true;
          await fsPromises.writeFile(statePath, externalBytes);
          const error = new Error('injected busy file');
          error.code = 'EBUSY';
          throw error;
        }
        return fsPromises.rename(from, to);
      },
    });
    const store = await openStateStore(statePath, { domain: makeFakeDomain(), clock, fs: io });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(18),
    });
    await expectCode(store.submitReview(request), 'external_modification');
    assert.deepEqual(await readFile(statePath), externalBytes, 'the external bytes must be preserved');
    assert.equal(store.getSnapshot().writable, false);
    assert.equal(store.getSnapshot().readOnlyReason, 'external_modification');
    await store.close();
  });
});

test('a rename that reports an error after replacing is accepted as verified', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, digest } = await writeStateFile(dir, state);
    const fsPromises = await import('node:fs/promises');
    const io = fakeIo({
      async rename(from, to) {
        await fsPromises.rename(from, to);
        if (to === statePath && from.endsWith('.pending')) {
          const error = new Error('injected error after replacement');
          error.code = 'EIO';
          throw error;
        }
      },
    });
    const store = await openStateStore(statePath, { domain: makeFakeDomain(), clock, fs: io });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(8),
    });
    const result = await store.submitReview(request);
    assert.equal(result.outcome, 'saved');
    assert.equal(result.commitStatus, 'verified');
    assert.equal(result.renameAttempts, 1);
    assert.equal(store.getSnapshot().stateVersion, 2);
    await store.close();
  });
});

test('successful rename with a failed post-read is replaced_unverified and stops writes', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, digest } = await writeStateFile(dir, state);
    const fsPromises = await import('node:fs/promises');
    let corruptReads = false;
    const io = fakeIo({
      async readFile(target, options) {
        if (corruptReads && target === statePath) {
          return Buffer.from('{"schemaVersion":"0.2"}\n');
        }
        return fsPromises.readFile(target, options);
      },
    });
    const store = await openStateStore(statePath, {
      domain: makeFakeDomain(),
      clock,
      fs: io,
      hooks: {
        afterRename() {
          corruptReads = true;
        },
      },
    });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(9),
    });
    try {
      await store.submitReview(request);
      assert.fail('expected write_unverified');
    } catch (error) {
      assert.equal(error.code, 'write_unverified');
      assert.equal(error.commitStatus, 'replaced_unverified');
      assert.ok(error.details.backupPath);
    }
    assert.equal(store.getSnapshot().writable, false);
    assert.equal(store.getSnapshot().readOnlyReason, 'write_unverified');
    await expectCode(
      store.submitReview({
        ...request,
        idempotencyKey: uuid(10),
      }),
      'write_unverified',
    );
    await store.close();

    // A new process reads the actually complete file and may write again.
    corruptReads = false;
    const reopened = await openStateStore(statePath, { domain: makeFakeDomain(), clock });
    assert.equal(reopened.getSnapshot().writable, true);
    assert.equal(reopened.getSnapshot().stateVersion, 2);
    await reopened.close();
  });
});

test('an undecidable replacement reports commit_unknown and stops writes', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const fsPromises = await import('node:fs/promises');
    const io = fakeIo({
      async rename(from, to) {
        if (to === statePath && from.endsWith('.pending')) {
          await fsPromises.writeFile(statePath, '{"schemaVersion":"9.9"}\n');
          const error = new Error('injected ambiguous replacement');
          error.code = 'EIO';
          throw error;
        }
        return fsPromises.rename(from, to);
      },
    });
    const store = await openStateStore(statePath, { domain: makeFakeDomain(), clock, fs: io });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(11),
    });
    try {
      await store.submitReview(request);
      assert.fail('expected commit_unknown');
    } catch (error) {
      assert.equal(error.code, 'commit_unknown');
      assert.equal(error.commitStatus, 'unknown');
      assert.ok(error.details.temporaryPath);
    }
    assert.notDeepEqual(await readFile(statePath), bytes);
    assert.equal(store.getSnapshot().writable, false);
    await store.close();
  });
});

test('an invalid generated next state stops writes before the replacement', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const domain = makeFakeDomain();
    const apply = domain.applyReview.bind(domain);
    domain.applyReview = async (...args) => {
      const result = await apply(...args);
      return { ...result, state: { ...result.state, stateVersion: result.state.stateVersion + 1 } };
    };
    const store = await openStateStore(statePath, { domain, clock });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(19),
    });
    await expectCode(store.submitReview(request), 'state_validation_failed');
    assert.deepEqual(await readFile(statePath), bytes);
    assert.equal(store.getSnapshot().writable, false);
    assert.equal(store.getSnapshot().readOnlyReason, 'state_validation_failed');
    await store.close();
  });
});

test('view failure keeps the decision verified as saved_view_pending; regeneration adds no review', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, digest } = await writeStateFile(dir, state);
    let renderMode = 'fail';
    const store = await openStateStore(statePath, {
      domain: makeFakeDomain(),
      clock,
      renderViews() {
        if (renderMode === 'fail') throw new Error('injected render failure');
        return '<!doctype html><title>review map</title>';
      },
    });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(12),
    });
    const result = await store.submitReview(request);
    assert.equal(result.outcome, 'saved_view_pending');
    assert.equal(result.commitStatus, 'verified');
    assert.equal(result.viewStatus.status, 'pending');
    assert.equal(store.getSnapshot().state.reviews.length, 1);
    const committed = await readFile(statePath);
    const committedDigest = sha256Bytes(committed);

    renderMode = 'ok';
    const regenerated = await store.regenerateView();
    assert.equal(regenerated.viewStatus.status, 'rendered');
    const viewPath = path.join(dir, 'product-map.review.html');
    assert.equal((await readFile(viewPath, 'utf8')).includes('review map'), true);
    assert.deepEqual(await readFile(statePath), committed);
    assert.equal(sha256Bytes(committed), committedDigest);
    assert.equal(store.getSnapshot().state.reviews.length, 1);
    await store.close();
  });
});

test('two states in one directory keep separate locks but never share a view file', async () => {
  await withTempDir(async (dir) => {
    const first = await writeStateFile(dir, makeStoreState(), 'state-a.json');
    const second = await writeStateFile(dir, makeStoreState(), 'state-b.json');
    const storeA = await openStateStore(first.statePath, {
      domain: makeFakeDomain(),
      clock,
      renderViews: () => '<html>view A</html>',
    });
    const storeB = await openStateStore(second.statePath, {
      domain: makeFakeDomain(),
      clock,
      renderViews: () => '<html>view B</html>',
    });
    try {
      const resultA = await storeA.submitReview(
        deferRequest({
          projectId: 'project:store-test',
          stateVersion: 1,
          digest: first.digest,
          idempotencyKey: uuid(24),
        }),
      );
      assert.equal(resultA.outcome, 'saved');
      const viewPath = path.join(dir, 'product-map.review.html');
      const viewA = await readFile(viewPath, 'utf8');
      assert.ok(viewA.includes('view A'));
      assert.match(viewA, /^<!-- product-continuity-view owner=sha256:[0-9a-f]{64} stateVersion=2 fileDigest=sha256:[0-9a-f]{64} -->/);

      const resultB = await storeB.submitReview(
        deferRequest({
          projectId: 'project:store-test',
          stateVersion: 1,
          digest: second.digest,
          idempotencyKey: uuid(25),
        }),
      );
      assert.equal(resultB.outcome, 'saved_view_pending');
      assert.equal(resultB.commitStatus, 'verified');
      assert.equal(resultB.viewStatus.status, 'pending');
      assert.deepEqual(await readFile(viewPath), Buffer.from(viewA), 'the other state view must not be replaced');
      assert.equal(storeB.getSnapshot().state.reviews.length, 1, 'the state write still succeeds');
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });
});

test('the default view path that is another state fact source is never overwritten', async () => {
  await withTempDir(async (dir) => {
    const viewPath = path.join(dir, 'product-map.review.html');
    const secondState = await writeStateFile(dir, makeStoreState(), 'product-map.review.html');
    const firstState = await writeStateFile(dir, makeStoreState(), 'state.json');
    const secondBytes = await readFile(secondState.statePath);
    const store = await openStateStore(firstState.statePath, {
      domain: makeFakeDomain(),
      clock,
      renderViews: () => '<html>should not replace json</html>',
    });
    const result = await store.submitReview(
      deferRequest({
        projectId: 'project:store-test',
        stateVersion: 1,
        digest: firstState.digest,
        idempotencyKey: uuid(26),
      }),
    );
    assert.equal(result.outcome, 'saved_view_pending');
    assert.deepEqual(await readFile(secondState.statePath), secondBytes);
    await store.close();

    const storeOnFactSource = await openStateStore(secondState.statePath, {
      domain: makeFakeDomain(),
      clock,
      renderViews: () => '<html>not a view</html>',
    });
    try {
      await expectCode(storeOnFactSource.regenerateView(), 'render_failed');
      assert.deepEqual(await readFile(secondState.statePath), secondBytes);
      assert.equal(storeOnFactSource.getSnapshot().writable, true);
    } finally {
      await storeOnFactSource.close();
    }
    assert.equal(viewPath, secondState.statePath);
  });
});

test('a symlinked or junction view target is refused without touching its target', async (t) => {
  await withTempDir(async (dir) => {
    const target = await writeStateFile(dir, makeStoreState(), 'target-state.json');
    const viewPath = path.join(dir, 'product-map.review.html');
    const state = await writeStateFile(dir, makeStoreState(), 'state.json');

    let targetBytes = await readFile(target.statePath);
    let junctionTarget = null;
    try {
      await symlink(target.statePath, viewPath);
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      // Windows can create a directory junction without the file-symlink
      // privilege. It is still a reparse point and must be refused.
      junctionTarget = path.join(dir, 'junction-target');
      await mkdir(junctionTarget);
      await writeFile(path.join(junctionTarget, 'keep.txt'), 'keep this\n');
      targetBytes = Buffer.from('keep this\n');
      try {
        await symlink(junctionTarget, viewPath, 'junction');
      } catch (junctionError) {
        if (junctionError.code === 'EPERM' || junctionError.code === 'EACCES') {
          t.skip('this Windows account cannot create a symlink or junction');
          return;
        }
        throw junctionError;
      }
    }
    const store = await openStateStore(state.statePath, {
      domain: makeFakeDomain(),
      clock,
      renderViews: () => '<html>symlink overwrite</html>',
    });
    try {
      await expectCode(store.regenerateView(), 'render_failed');
      if (junctionTarget) {
        assert.deepEqual(await readFile(path.join(junctionTarget, 'keep.txt')), targetBytes);
      } else {
        assert.deepEqual(await readFile(target.statePath), targetBytes);
      }
      assert.equal((await lstat(viewPath)).isSymbolicLink(), true);
    } finally {
      await store.close();
    }
  });
});

test('a hard-linked view target is refused without touching its target', async (t) => {
  await withTempDir(async (dir) => {
    const target = await writeStateFile(dir, makeStoreState(), 'target-state.json');
    const targetBytes = await readFile(target.statePath);
    const viewPath = path.join(dir, 'product-map.review.html');
    const state = await writeStateFile(dir, makeStoreState(), 'state.json');

    try {
      await link(target.statePath, viewPath);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EXDEV') {
        t.skip('hardlink creation is not permitted on this platform');
        return;
      }
      throw error;
    }
    const store = await openStateStore(state.statePath, {
      domain: makeFakeDomain(),
      clock,
      renderViews: () => '<html>hardlink overwrite</html>',
    });
    try {
      await expectCode(store.regenerateView(), 'render_failed');
      assert.deepEqual(await readFile(target.statePath), targetBytes);
      assert.equal((await lstat(viewPath)).nlink, 2);
    } finally {
      await store.close();
    }
  });
});

test('unowned and other-owned view files are refused', async () => {
  await withTempDir(async (dir) => {
    const state = await writeStateFile(dir, makeStoreState(), 'state.json');
    const viewPath = path.join(dir, 'product-map.review.html');
    const store = await openStateStore(state.statePath, {
      domain: makeFakeDomain(),
      clock,
      renderViews: () => '<html>replacement</html>',
    });
    try {
      await writeFile(viewPath, 'plain unowned file\n');
      const plainBytes = await readFile(viewPath);
      await expectCode(store.regenerateView(), 'render_failed');
      assert.deepEqual(await readFile(viewPath), plainBytes);

      const otherMarker = `<!-- product-continuity-view owner=sha256:${'a'.repeat(64)} stateVersion=1 fileDigest=sha256:${'b'.repeat(64)} -->\n<html>other</html>\n`;
      await writeFile(viewPath, otherMarker);
      await expectCode(store.regenerateView(), 'render_failed');
      assert.equal(await readFile(viewPath, 'utf8'), otherMarker);
    } finally {
      await store.close();
    }
  });
});

test('a renderer that replaces the view lock token cannot overwrite the old view', async () => {
  await withTempDir(async (dir) => {
    const state = await writeStateFile(dir, makeStoreState(), 'state.json');
    const viewPath = path.join(dir, 'product-map.review.html');
    const foreignLock = `${JSON.stringify({
      version: 1,
      token: 'foreign-view-token-from-renderer',
      pid: 616161,
      host: 'foreign-host',
      statePath: viewPath,
      startedAt: now,
    })}\n`;
    let mode = 'ok';
    const store = await openStateStore(state.statePath, {
      domain: makeFakeDomain(),
      clock,
      renderViews: async ({ state: current }) => {
        if (mode === 'replace-lock') {
          await writeFile(`${viewPath}${LOCK_SUFFIX}`, foreignLock);
        }
        return `<html>view version ${current.stateVersion}</html>`;
      },
    });
    try {
      const first = await store.submitReview(
        deferRequest({
          projectId: 'project:store-test',
          stateVersion: 1,
          digest: state.digest,
          idempotencyKey: uuid(33),
        }),
      );
      assert.equal(first.outcome, 'saved');
      const oldView = await readFile(viewPath);

      mode = 'replace-lock';
      const afterFirst = store.getSnapshot();
      const second = await store.submitReview(
        deferRequest({
          projectId: 'project:store-test',
          stateVersion: afterFirst.stateVersion,
          digest: afterFirst.fileDigest,
          idempotencyKey: uuid(34),
        }),
      );
      assert.equal(second.outcome, 'saved_view_pending');
      assert.equal(second.commitStatus, 'verified');
      assert.equal(second.viewStatus.status, 'pending');
      assert.equal(second.viewStatus.error.code, 'view_lock_lost');
      assert.deepEqual(await readFile(viewPath), oldView, 'the old view bytes must be preserved');
      assert.equal(await readFile(`${viewPath}${LOCK_SUFFIX}`, 'utf8'), foreignLock);
      assert.equal(store.getSnapshot().writable, true, 'the verified state commit remains writable');
      assert.equal(store.getSnapshot().state.reviews.length, 2);
    } finally {
      await store.close();
    }
    assert.equal(
      await readFile(`${viewPath}${LOCK_SUFFIX}`, 'utf8'),
      foreignLock,
      'close must not delete a foreign view lock',
    );
  });
});

test('a view lock replaced during staging is caught immediately before the view rename', async () => {
  await withTempDir(async (dir) => {
    const state = await writeStateFile(dir, makeStoreState(), 'state.json');
    const viewPath = path.join(dir, 'product-map.review.html');
    const foreignLock = `${JSON.stringify({
      version: 1,
      token: 'foreign-view-token-from-staging',
      pid: 717171,
      host: 'foreign-host',
      statePath: viewPath,
      startedAt: now,
    })}\n`;
    const fsPromises = await import('node:fs/promises');
    let replaced = false;
    const io = createIoAdapter({
      async readFile(target, options) {
        const bytes = await fsPromises.readFile(target, options);
        if (!replaced && target.startsWith(`${viewPath}.`) && target.endsWith('.pending')) {
          replaced = true;
          await writeFile(`${viewPath}${LOCK_SUFFIX}`, foreignLock);
        }
        return bytes;
      },
    });
    const store = await openStateStore(state.statePath, {
      domain: makeFakeDomain(),
      clock,
      fs: io,
      renderViews: () => '<html>must not be written</html>',
    });
    try {
      const result = await store.submitReview(
        deferRequest({
          projectId: 'project:store-test',
          stateVersion: 1,
          digest: state.digest,
          idempotencyKey: uuid(35),
        }),
      );
      assert.equal(result.outcome, 'saved_view_pending');
      assert.equal(result.commitStatus, 'verified');
      assert.equal(result.viewStatus.error.code, 'view_lock_lost');
      await assert.rejects(readFile(viewPath), (error) => error.code === 'ENOENT');
      assert.equal(replaced, true);
      assert.equal(await readFile(`${viewPath}${LOCK_SUFFIX}`, 'utf8'), foreignLock);
      assert.equal(store.getSnapshot().state.reviews.length, 1);
      assert.equal(store.getSnapshot().writable, true);
    } finally {
      await store.close();
    }
    assert.equal(await readFile(`${viewPath}${LOCK_SUFFIX}`, 'utf8'), foreignLock);
  });
});

test('a renderer that writes nothing is not a success even when an old owned view exists', async () => {
  await withTempDir(async (dir) => {
    const state = await writeStateFile(dir, makeStoreState(), 'state.json');
    let mode = 'ok';
    const store = await openStateStore(state.statePath, {
      domain: makeFakeDomain(),
      clock,
      renderViews: ({ state: current }) => (mode === 'ok' ? `<html>version ${current.stateVersion}</html>` : undefined),
    });
    try {
      const first = await store.submitReview(
        deferRequest({
          projectId: 'project:store-test',
          stateVersion: 1,
          digest: state.digest,
          idempotencyKey: uuid(27),
        }),
      );
      assert.equal(first.outcome, 'saved');
      const viewPath = path.join(dir, 'product-map.review.html');
      const ownedView = await readFile(viewPath);
      const viewText = ownedView.toString('utf8');
      assert.match(viewText, /^<!-- product-continuity-view owner=sha256:[0-9a-f]{64} stateVersion=2 fileDigest=sha256:[0-9a-f]{64} -->/);

      mode = 'silent';
      const afterFirst = store.getSnapshot();
      const second = await store.submitReview(
        deferRequest({
          projectId: 'project:store-test',
          stateVersion: afterFirst.stateVersion,
          digest: afterFirst.fileDigest,
          idempotencyKey: uuid(28),
        }),
      );
      assert.equal(second.outcome, 'saved_view_pending');
      assert.equal(second.commitStatus, 'verified');
      assert.equal(second.viewStatus.error.code, 'render_no_output');
      assert.deepEqual(await readFile(viewPath), ownedView, 'an old view is not this render success');

      mode = 'ok';
      const regenerated = await store.regenerateView();
      assert.equal(regenerated.viewStatus.status, 'rendered');
      assert.match(
        (await readFile(viewPath, 'utf8')),
        /stateVersion=3 fileDigest=sha256:[0-9a-f]{64}/,
      );
    } finally {
      await store.close();
    }
  });
});

test('oversized next state is rejected with state_too_large and never truncated', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const store = await openStateStore(statePath, {
      domain: makeFakeDomain(),
      clock,
      maxStateBytes: bytes.byteLength + 100,
    });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(13),
      note: 'x'.repeat(1500),
    });
    await expectCode(store.submitReview(request), 'state_too_large');
    assert.deepEqual(await readFile(statePath), bytes);
    await store.close();
  });
});

test('open rejects oversized state before creating a lock', async () => {
  await withTempDir(async (dir) => {
    const { statePath } = await writeStateFile(dir, makeStoreState());
    await expectCode(
      openStateStore(statePath, { domain: makeFakeDomain(), maxStateBytes: 100 }),
      'state_too_large',
    );
    await assert.rejects(readFile(`${statePath}${LOCK_SUFFIX}`), (error) => error.code === 'ENOENT');
  });
});

test('a 0.1 state opens read-only with an explicit migration reason', async () => {
  await withTempDir(async (dir) => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/state-0.1-shared-decision.json', import.meta.url), 'utf8'),
    );
    const statePath = path.join(dir, 'legacy.json');
    const bytes = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    await writeFile(statePath, bytes);
    const store = await openStateStore(statePath, { domain: makeFakeDomain() });
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.writable, false);
    assert.equal(snapshot.readOnlyReason, 'schema_0_1_requires_migration');
    await expectCode(
      store.submitReview(
        deferRequest({
          projectId: 'project:shared-legacy',
          stateVersion: 1,
          digest: sha256Bytes(bytes),
          idempotencyKey: uuid(14),
        }),
      ),
      'migration_required',
    );
    assert.deepEqual(await readFile(statePath), bytes);
    await store.close();
  });
});

test('hard-linked fact sources and UNC paths are rejected before locking', async () => {
  await withTempDir(async (dir) => {
    const { statePath } = await writeStateFile(dir, makeStoreState());
    const hardPath = path.join(dir, 'hard-link.json');
    try {
      await link(statePath, hardPath);
      await expectCode(openStateStore(hardPath, { domain: makeFakeDomain() }), 'hardlink_state');
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EXDEV') throw error;
    }
    if (process.platform === 'win32') {
      await expectCode(
        canonicalizeStatePath('\\\\server\\share\\state.json', { mustExist: false }),
        'unc_path',
      );
    }
  });
});

test('two processes contend for the same cooperative lock', async () => {
  await withTempDir(async (dir) => {
    const { statePath } = await writeStateFile(dir, makeStoreState());
    const holderPath = fileURLToPath(new URL('./store-lock-holder.mjs', import.meta.url));
    const child = spawn(process.execPath, [holderPath, statePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`lock holder timed out: ${stderr}`)), 10000);
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (stdout.includes('locked')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code) => {
          if (code !== null && !stdout.includes('locked')) {
            clearTimeout(timer);
            reject(new Error(`lock holder exited ${code}: ${stderr}`));
          }
        });
      });
      await expectCode(openStateStore(statePath, { domain: makeFakeDomain() }), 'lock_held');
      child.stdin.end();
      const exitCode = await new Promise((resolve) => child.once('exit', resolve));
      assert.equal(exitCode, 0);
      const store = await openStateStore(statePath, { domain: makeFakeDomain() });
      await store.close();
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
});

test('multi-lock acquisition sorts by identity and releases its acquired locks on failure', async () => {
  await withTempDir(async (dir) => {
    const first = await canonicalizeStatePath(path.join(dir, 'first.json'), { mustExist: false });
    const second = await canonicalizeStatePath(path.join(dir, 'second.json'), { mustExist: false });
    const held = await acquireStateLocks([second.path], {});
    try {
      await expectCode(acquireStateLocks([first.path, second.path], {}), 'lock_held');
      await assert.rejects(readFile(`${first.path}${LOCK_SUFFIX}`), (error) => error.code === 'ENOENT');
      assert.equal(
        (await readFile(`${second.path}${LOCK_SUFFIX}`, 'utf8')).includes(held[0].token),
        true,
      );
    } finally {
      const released = await releaseStateLocks(held, {});
      assert.equal(released[0], true);
    }
  });
});

test('real applyReview integrates with idempotent replay across restart', async () => {
  await withTempDir(async (dir) => {
    const { statePath, digest } = await writeStateFile(dir, makeStoreState());
    let store = await openStateStore(statePath, { clock });
    const projectId = 'project:store-test';
    const editRequest = {
      projectId,
      action: 'edit_candidate',
      targetClaimId: 'claim:demo:v1',
      payload: {
        content: {
          statement: 'Users can browse the demo catalog.',
          scope: ['Demo storefront'],
          conditions: [],
          exceptions: [],
        },
        assessment: { disposition: 'single', reviewedLegacyContext: false },
        note: 'Prepared in the integration test.',
      },
      expectedStateVersion: 1,
      expectedDigest: digest,
      idempotencyKey: uuid(20),
    };
    const editResult = await store.submitReview(editRequest);
    assert.equal(editResult.commitStatus, 'verified');
    const afterEdit = store.getSnapshot();
    assert.equal(afterEdit.stateVersion, 2);
    assert.equal(afterEdit.state.reviews.length, 1);
    const prepared = afterEdit.state.intentClaims.find((claim) => claim.id !== 'claim:demo:v1');
    assert.ok(prepared, 'edit_candidate must create a new claim');
    assert.equal(prepared.status, 'candidate');
    assert.equal(prepared.assessment.disposition, 'single');

    const previewRequest = {
      projectId,
      action: 'confirm_candidate',
      targetClaimId: prepared.id,
      payload: {},
      expectedStateVersion: afterEdit.stateVersion,
      expectedDigest: afterEdit.fileDigest,
    };
    const beforePreviewBytes = await readFile(statePath);
    const preview = await store.preview(previewRequest);
    assert.deepEqual(await readFile(statePath), beforePreviewBytes, 'preview must not write');
    const confirmRequest = {
      projectId,
      action: 'confirm_candidate',
      targetClaimId: prepared.id,
      payload: {
        previewDigest: preview.preview.previewDigest,
        confirmationAttested: true,
      },
      expectedStateVersion: afterEdit.stateVersion,
      expectedDigest: afterEdit.fileDigest,
      idempotencyKey: uuid(21),
    };
    const confirmResult = await store.submitReview(confirmRequest);
    assert.equal(confirmResult.outcome, 'saved');
    assert.equal(confirmResult.commitStatus, 'verified');
    assert.equal(confirmResult.resultingStateVersion, 3);
    const committed = await readFile(statePath);
    assert.equal(sha256Bytes(committed), confirmResult.currentDigest);
    assert.equal(store.getSnapshot().state.intentClaims.find((claim) => claim.id === prepared.id).status, 'confirmed');

    const retry = await store.submitReview(confirmRequest);
    assert.equal(retry.outcome, 'replayed');
    assert.equal(retry.reviewId, confirmResult.reviewId);
    assert.deepEqual(await readFile(statePath), committed);
    await store.close();

    store = await openStateStore(statePath, { clock });
    const restartRetry = await store.submitReview(confirmRequest);
    assert.equal(restartRetry.outcome, 'replayed');
    assert.equal(restartRetry.reviewId, confirmResult.reviewId);
    assert.equal(restartRetry.currentStateVersion, 3);
    assert.deepEqual(await readFile(statePath), committed);
    await store.close();
  });
});

test('startup scan reports exact-prefix pending/failed artifacts without deleting or using them', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes } = await writeStateFile(dir, makeStoreState());
    const base = path.basename(statePath);
    const pendingName = `${base}.12345.${'a'.repeat(12)}.pending`;
    const failedName = `${base}.bak.1.${'b'.repeat(8)}.${'c'.repeat(8)}.${'d'.repeat(6)}.failed`;
    const unrelated = `${base}.v0.2.json.12345.${'e'.repeat(12)}.pending`;
    await writeFile(path.join(dir, pendingName), 'leftover pending');
    await writeFile(path.join(dir, failedName), 'leftover failed');
    await writeFile(path.join(dir, unrelated), 'not this state transaction');
    const store = await openStateStore(statePath, { domain: makeFakeDomain(), clock });
    try {
      const snapshot = store.getSnapshot();
      assert.ok(snapshot.startupWarnings.some((warning) => warning.includes(pendingName)));
      assert.ok(snapshot.startupWarnings.some((warning) => warning.includes(failedName)));
      assert.deepEqual(snapshot.diagnostics.pendingArtifacts, [pendingName]);
      assert.deepEqual(snapshot.diagnostics.failedArtifacts, [failedName]);
      assert.equal(snapshot.stateVersion, 1);
      assert.equal(snapshot.state.reviews.length, 0);
      assert.deepEqual(await readFile(statePath), bytes);
      assert.equal(await readFile(path.join(dir, pendingName), 'utf8'), 'leftover pending');
      assert.equal(await readFile(path.join(dir, failedName), 'utf8'), 'leftover failed');
      assert.equal(await readFile(path.join(dir, unrelated), 'utf8'), 'not this state transaction');
    } finally {
      await store.close();
    }
  });
});

test('an unverifiable state stops writes and does not recover when the bytes are restored', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const store = await openStateStore(statePath, { domain: makeFakeDomain(), clock });
    const request = deferRequest({
      projectId: state.project.id,
      stateVersion: 1,
      digest,
      idempotencyKey: uuid(29),
    });
    try {
      await writeFile(statePath, '{"schemaVersion":');
      await expectCode(store.submitReview(request), 'invalid_state');
      assert.equal(store.getSnapshot().writable, false);
      assert.equal(store.getSnapshot().readOnlyReason, 'invalid_state_on_disk');

      await writeFile(statePath, bytes);
      await expectCode(store.submitReview(request), 'invalid_state');
      assert.deepEqual(await readFile(statePath), bytes);
      assert.equal(store.getSnapshot().writable, false);
      assert.equal(store.getSnapshot().readOnlyReason, 'invalid_state_on_disk');
    } finally {
      await store.close();
    }
  });
});

test('a hard link added after open is rejected on every action', async (t) => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, bytes, digest } = await writeStateFile(dir, state);
    const alias = path.join(dir, 'late-hardlink.json');
    const store = await openStateStore(statePath, { domain: makeFakeDomain(), clock });
    try {
      try {
        await link(statePath, alias);
      } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EXDEV') {
          t.skip('hardlink creation is not permitted on this platform');
          return;
        }
        throw error;
      }
      assert.equal((await lstat(statePath)).nlink, 2);
      await expectCode(
        store.submitReview(
          deferRequest({
            projectId: state.project.id,
            stateVersion: 1,
            digest,
            idempotencyKey: uuid(30),
          }),
        ),
        'hardlink_state',
      );
      assert.deepEqual(await readFile(statePath), bytes);
      assert.equal(store.getSnapshot().writable, false);
      assert.equal(store.getSnapshot().readOnlyReason, 'hardlink_state');
    } finally {
      await store.close();
    }
  });
});

test('trusted decisionRecordPath is passed to preview and apply unchanged', async () => {
  await withTempDir(async (dir) => {
    const state = makeStoreState();
    const { statePath, digest } = await writeStateFile(dir, state);
    const seen = [];
    const domain = makeFakeDomain();
    const preview = domain.previewReview.bind(domain);
    const apply = domain.applyReview.bind(domain);
    domain.previewReview = async (current, request, options) => {
      seen.push({ kind: 'preview', options });
      return preview(current, request, options);
    };
    domain.applyReview = async (current, request, options) => {
      seen.push({ kind: 'apply', options });
      return apply(current, request, options);
    };
    const trusted = '.product-continuity/project-state.json';
    const store = await openStateStore(statePath, {
      domain,
      clock,
      decisionRecordPath: trusted,
    });
    try {
      const previewRequest = previewDeferRequest({
        projectId: state.project.id,
        stateVersion: 1,
        digest,
      });
      await store.preview(previewRequest);
      await store.submitReview(
        deferRequest({
          projectId: state.project.id,
          stateVersion: 1,
          digest,
          idempotencyKey: uuid(31),
        }),
      );
      assert.equal(seen.length, 2);
      for (const entry of seen) {
        assert.equal(entry.options.decisionRecordPath, trusted);
      }
    } finally {
      await store.close();
    }
  });
});

function hardExitChildSource() {
  const storeUrl = new URL('../scripts/state-store.mjs', import.meta.url).href;
  const fixtureUrl = new URL('./store-fixtures.mjs', import.meta.url).href;
  return `import { readFile } from 'node:fs/promises';
import { openStateStore, sha256Bytes } from ${JSON.stringify(storeUrl)};
import { makeFakeDomain, deferRequest, uuid } from ${JSON.stringify(fixtureUrl)};
const [statePath, phase] = process.argv.slice(2);
const bytes = await readFile(statePath);
const digest = sha256Bytes(bytes);
const hooks = {};
if (phase === 'before') hooks.beforeRename = () => process.exit(42);
if (phase === 'after') hooks.afterRename = () => process.exit(43);
const store = await openStateStore(statePath, { domain: makeFakeDomain(), hooks });
await store.submitReview(deferRequest({
  projectId: 'project:store-test',
  stateVersion: 1,
  digest,
  idempotencyKey: uuid(32),
}));
await store.close();
process.exit(0);
`;
}

async function runHardExitChild(dir, statePath, phase) {
  const childPath = path.join(dir, `hard-exit-${phase}.mjs`);
  await writeFile(childPath, hardExitChildSource());
  const child = spawn(process.execPath, [childPath, statePath, phase], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hard-exit child timed out: ${stderr}`));
    }, 15000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return { exitCode, stderr };
}

test('hard process exit before and after rename leaves explicit, verifiable leftovers and a lock that is not stolen', async () => {
  for (const phase of ['before', 'after']) {
    await withTempDir(async (dir) => {
      const state = makeStoreState();
      const { statePath, bytes, digest } = await writeStateFile(dir, state);
      const base = path.basename(statePath);
      const pendingPattern = new RegExp(
        `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.[0-9a-f]{12}\\.pending$`,
      );

      const child = await runHardExitChild(dir, statePath, phase);
      assert.equal(child.exitCode, phase === 'before' ? 42 : 43, child.stderr);
      const lockPath = `${statePath}${LOCK_SUFFIX}`;
      assert.equal((await readFile(lockPath, 'utf8')).length > 0, true, 'the lock remains after hard exit');
      await expectCode(openStateStore(statePath, { domain: makeFakeDomain() }), 'lock_held');

      const names = await readdir(dir);
      assert.equal(
        names.some((name) => pendingPattern.test(name)),
        phase === 'before',
        phase === 'before'
          ? 'the pre-rename temporary file is left with its precise name'
          : 'a successful rename leaves no pending state temporary',
      );
      assert.equal(names.filter((name) => name.includes('.bak.')).length, 1);
      const onDisk = JSON.parse((await readFile(statePath)).toString('utf8'));
      if (phase === 'before') {
        assert.equal(onDisk.stateVersion, 1);
        assert.equal(onDisk.reviews.length, 0);
        assert.deepEqual(await readFile(statePath), bytes);
      } else {
        assert.equal(onDisk.stateVersion, 2);
        assert.equal(onDisk.reviews.length, 1);
        assert.notDeepEqual(await readFile(statePath), bytes);
      }

      await unlink(lockPath);
      const recovered = await openStateStore(statePath, { domain: makeFakeDomain(), clock });
      try {
        assert.equal(recovered.getSnapshot().writable, true);
        assert.equal(recovered.getSnapshot().stateVersion, phase === 'before' ? 1 : 2);
        if (phase === 'after') {
          const replay = await recovered.submitReview(
            deferRequest({
              projectId: state.project.id,
              stateVersion: 1,
              digest,
              idempotencyKey: uuid(32),
            }),
          );
          assert.equal(replay.outcome, 'replayed');
          assert.equal(replay.resultingStateVersion, 2);
        }
      } finally {
        await recovered.close();
      }
    });
  }
});

test('StoreError carries only stable code/status/commitStatus and no token', () => {
  const error = new StoreError('lock_held', 'held', {
    status: 503,
    details: { owner: { pid: 1 } },
  });
  assert.equal(error.code, 'lock_held');
  assert.equal(error.status, 503);
  assert.equal(error.commitStatus, 'not_committed');
  assert.equal(JSON.stringify(error.details).includes('token'), false);
});
