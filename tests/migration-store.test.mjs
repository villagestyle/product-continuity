import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION_OUTPUT_SUFFIX,
  formatMigrationResult,
  runMigrationCli,
} from '../scripts/migrate-state.mjs';
import {
  LOCK_SUFFIX,
  acquireStateLocks,
  canonicalizeStatePath,
  createIoAdapter,
  releaseStateLocks,
  sha256Bytes,
  validateFullState,
} from '../scripts/state-store.mjs';
import { makeTempDir } from './store-fixtures.mjs';

const clock = () => new Date('2026-01-02T03:04:05.000Z');
const fixture01 = new URL('./fixtures/state-0.1-shared-decision.json', import.meta.url);
const fixture02 = new URL('./fixtures/state-0.2-empty.json', import.meta.url);

async function withTempDir(fn) {
  const dir = await makeTempDir('pc-migrate-');
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFixture(dir, name, url) {
  const statePath = path.join(dir, name);
  const bytes = await readFile(url);
  await writeFile(statePath, bytes);
  return { statePath, bytes, digest: sha256Bytes(bytes) };
}

async function backupNames(dir) {
  return (await readdir(dir)).filter((name) => name.includes('.bak.'));
}

async function expectLockAbsent(statePath) {
  await assert.rejects(
    readFile(`${statePath}${LOCK_SUFFIX}`),
    (error) => error.code === 'ENOENT',
  );
}

test('default copy migration uses raw source bytes, verifies output and leaves the source untouched', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes, digest } = await writeFixture(dir, 'legacy.json', fixture01);
    const result = await runMigrationCli([statePath], { clock });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'migrated');
    assert.equal(result.commitStatus, 'verified');
    assert.equal(result.sourceDigest, digest);
    assert.equal(result.outputPath, `${statePath}${MIGRATION_OUTPUT_SUFFIX}`);
    assert.equal(result.backupPath, null);
    assert.deepEqual(result.added, {
      confirmedClaims: 0,
      decisions: 0,
      testExecutions: 0,
      runtimeObservations: 0,
    });
    assert.equal(result.report.generatedCandidateClaimIds.length, 2);
    assert.equal(result.report.legacyConfirmedDecisionIds.length, 1);
    assert.equal(result.report.addedConfirmedClaims, 0);

    const outputBytes = await readFile(result.outputPath);
    assert.equal(sha256Bytes(outputBytes), result.outputDigest);
    const outputState = JSON.parse(outputBytes.toString('utf8'));
    assert.equal(outputState.schemaVersion, '0.2');
    assert.equal(outputState.migration.sourceDigest, digest);
    assert.deepEqual(validateFullState(outputState), []);
    assert.deepEqual(await readFile(statePath), bytes, 'the source bytes must not change');
    assert.equal((await backupNames(dir)).length, 0, 'a new-copy migration needs no target backup');
    await expectLockAbsent(statePath);
    await expectLockAbsent(result.outputPath);

    const text = formatMigrationResult(result);
    assert.ok(text.includes('added this run: confirmed claims 0, decisions 0, test executions 0, runtime observations 0'));
  });
});

test('an existing output is never overwritten, even by repeated migration', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes } = await writeFixture(dir, 'legacy.json', fixture01);
    const targetPath = `${statePath}${MIGRATION_OUTPUT_SUFFIX}`;
    const sentinel = Buffer.from('existing target sentinel\n', 'utf8');
    await writeFile(targetPath, sentinel);

    const result = await runMigrationCli([statePath], { clock });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'target_exists');
    assert.equal(result.commitStatus, 'not_committed');
    assert.deepEqual(await readFile(targetPath), sentinel);
    assert.deepEqual(await readFile(statePath), bytes);
    await expectLockAbsent(statePath);
    await expectLockAbsent(targetPath);

    // Removing the sentinel allows the copy, and another run still refuses.
    await rm(targetPath);
    const first = await runMigrationCli([statePath], { clock });
    assert.equal(first.outcome, 'migrated');
    const outputBytes = await readFile(first.outputPath);
    const repeated = await runMigrationCli([statePath], { clock });
    assert.equal(repeated.outcome, 'target_exists');
    assert.deepEqual(await readFile(first.outputPath), outputBytes);
  });
});

test('0.2 input is a read-only no-op that writes no output and no review', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes, digest } = await writeFixture(dir, 'current.json', fixture02);
    const result = await runMigrationCli([statePath], { clock });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'no_op');
    assert.equal(result.commitStatus, 'not_committed');
    assert.equal(result.sourceDigest, digest);
    assert.equal(result.outputPath, null);
    assert.equal(result.backupPath, null);
    assert.deepEqual(result.added, {
      confirmedClaims: 0,
      decisions: 0,
      testExecutions: 0,
      runtimeObservations: 0,
    });
    assert.deepEqual(await readFile(statePath), bytes);
    await assert.rejects(
      readFile(`${statePath}${MIGRATION_OUTPUT_SUFFIX}`),
      (error) => error.code === 'ENOENT',
    );
    await expectLockAbsent(statePath);
  });
});

test('in-place migration keeps a verified versioned backup and never fabricates new decisions', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes, digest } = await writeFixture(dir, 'legacy.json', fixture01);
    const result = await runMigrationCli([statePath, '--in-place'], { clock });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'migrated');
    assert.equal(result.commitStatus, 'verified');
    assert.equal(result.outputPath, statePath);
    assert.equal(result.sourceDigest, digest);
    assert.ok(result.backupPath, 'in-place migration must create a backup');
    assert.equal(sha256Bytes(await readFile(result.backupPath)), digest);
    assert.deepEqual(await readFile(result.backupPath), bytes);

    const migrated = JSON.parse((await readFile(statePath)).toString('utf8'));
    assert.equal(migrated.schemaVersion, '0.2');
    assert.equal(migrated.migration.sourceDigest, digest);
    assert.equal(migrated.stateVersion, 2);
    assert.deepEqual(validateFullState(migrated), []);
    assert.equal(migrated.decisions.length, 1);
    assert.equal(migrated.decisions[0].recordVersion, '0.1');
    assert.equal(result.report.addedConfirmedClaims, 0);
    assert.equal(result.report.addedDecisions, 0);
    assert.equal(result.report.addedTestExecutions, 0);
    assert.equal(result.report.addedRuntimeObservations, 0);
    assert.equal((await backupNames(dir)).length, 1);
    await expectLockAbsent(statePath);

    const repeated = await runMigrationCli([statePath, '--in-place'], { clock });
    assert.equal(repeated.outcome, 'no_op');
    assert.equal((await backupNames(dir)).length, 1, '0.2 in-place must not create another backup');
  });
});

test('a source changed during copy is reported and the verified output is not called current', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes } = await writeFixture(dir, 'legacy.json', fixture01);
    let changed = false;
    const result = await runMigrationCli([statePath], {
      clock,
      hooks: {
        async afterCopyReadback({ outputPath }) {
          changed = true;
          await writeFile(statePath, Buffer.concat([bytes, Buffer.from(' ', 'utf8')]));
          await writeFile(path.join(dir, 'output-marker.txt'), outputPath);
        },
      },
    });
    assert.equal(changed, true);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'source_changed');
    assert.equal(result.outputStatus, 'verified_but_source_changed');
    assert.equal(result.commitStatus, 'unknown');
    assert.ok(result.outputPath);
    const outputState = JSON.parse((await readFile(result.outputPath)).toString('utf8'));
    assert.deepEqual(validateFullState(outputState), []);
    assert.equal((await readFile(statePath)).length, bytes.length + 1);
  });
});

test('migration refuses while another process holds the source lock and leaves no partial output', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes } = await writeFixture(dir, 'legacy.json', fixture01);
    const canonical = await canonicalizeStatePath(statePath, { mustExist: true });
    const held = await acquireStateLocks([canonical.path], {});
    try {
      const result = await runMigrationCli([statePath], { clock });
      assert.equal(result.ok, false);
      assert.equal(result.outcome, 'lock_held');
      assert.equal(result.commitStatus, 'not_committed');
      assert.deepEqual(await readFile(statePath), bytes);
      await assert.rejects(
        readFile(`${statePath}${MIGRATION_OUTPUT_SUFFIX}`),
        (error) => error.code === 'ENOENT',
      );
    } finally {
      const released = await releaseStateLocks(held, {});
      assert.equal(released[0], true);
    }
  });
});

test('default copy acquires source and target locks in order and releases the source on target conflict', async () => {
  await withTempDir(async (dir) => {
    const { statePath } = await writeFixture(dir, 'legacy.json', fixture01);
    const targetPath = `${statePath}${MIGRATION_OUTPUT_SUFFIX}`;
    const targetCanonical = await canonicalizeStatePath(targetPath, { mustExist: false });
    const held = await acquireStateLocks([targetCanonical.path], {});
    try {
      const result = await runMigrationCli([statePath], { clock });
      assert.equal(result.ok, false);
      assert.equal(result.outcome, 'lock_held');
      await expectLockAbsent(statePath);
      assert.equal(
        (await readFile(`${targetCanonical.path}${LOCK_SUFFIX}`, 'utf8')).includes(held[0].token),
        true,
      );
    } finally {
      await releaseStateLocks(held, {});
    }
  });
});

test('copy write and readback failures report partial output and never claim success', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes } = await writeFixture(dir, 'legacy.json', fixture01);
    const targetPath = `${statePath}${MIGRATION_OUTPUT_SUFFIX}`;

    const openFailure = createIoAdapter({
      async open(target, flags, mode) {
        if (target === targetPath) {
          const error = new Error('injected open failure');
          error.code = 'EACCES';
          throw error;
        }
        return fsp.open(target, flags, mode);
      },
    });
    const first = await runMigrationCli([statePath], { clock, fs: openFailure });
    assert.equal(first.ok, false);
    assert.equal(first.outcome, 'output_open_failed');
    await assert.rejects(readFile(targetPath), (error) => error.code === 'ENOENT');
    assert.deepEqual(await readFile(statePath), bytes);

    const readbackFailure = createIoAdapter({
      async readFile(target, options) {
        if (target === targetPath) return Buffer.from('not a state file\n', 'utf8');
        return fsp.readFile(target, options);
      },
    });
    const second = await runMigrationCli([statePath], { clock, fs: readbackFailure });
    assert.equal(second.ok, false);
    assert.equal(second.outcome, 'output_unverified');
    assert.equal(second.commitStatus, 'unknown');
    assert.equal(second.partialOutputPath, targetPath);
    assert.ok((await readFile(targetPath)).length > 0);
    assert.deepEqual(await readFile(statePath), bytes);
  });
});

test('in-place post-read failure is reported as replaced_unverified without deleting the backup', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes, digest } = await writeFixture(dir, 'legacy.json', fixture01);
    let corruptReads = false;
    const io = createIoAdapter({
      async readFile(target, options) {
        if (corruptReads && target === statePath) {
          return Buffer.from('{"schemaVersion":"0.2"}\n');
        }
        return fsp.readFile(target, options);
      },
    });
    const result = await runMigrationCli([statePath, '--in-place'], {
      clock,
      fs: io,
      hooks: {
        afterRename() {
          corruptReads = true;
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'write_unverified');
    assert.equal(result.commitStatus, 'replaced_unverified');
    assert.ok(result.backupPath);
    assert.equal(sha256Bytes(await readFile(result.backupPath)), digest);
    assert.notDeepEqual(await readFile(statePath), bytes);
    assert.equal((await backupNames(dir)).length, 1);
    await expectLockAbsent(statePath);
  });
});

test('in-place backup failure aborts before replacement and leaves the 0.1 source intact', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes } = await writeFixture(dir, 'legacy.json', fixture01);
    const result = await runMigrationCli([statePath, '--in-place'], {
      clock,
      hooks: {
        beforeBackupWrite() {
          throw new Error('injected backup failure');
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'backup_failed');
    assert.equal(result.commitStatus, 'not_committed');
    assert.deepEqual(await readFile(statePath), bytes);
    assert.equal((await backupNames(dir)).length, 0);
    assert.ok(result.details.temporaryPath.endsWith('.failed'));
    await expectLockAbsent(statePath);
  });
});

test('output equal to input is refused without --in-place, and --force is not an option', async () => {
  await withTempDir(async (dir) => {
    const { statePath, bytes } = await writeFixture(dir, 'legacy.json', fixture01);

    const same = await runMigrationCli([statePath, statePath], { clock });
    assert.equal(same.ok, false);
    assert.equal(same.outcome, 'output_same_as_input');
    assert.deepEqual(await readFile(statePath), bytes);

    const forced = await runMigrationCli(['--force', statePath], { clock });
    assert.equal(forced.ok, false);
    assert.equal(forced.outcome, 'usage_error');
    assert.equal(forced.exitCode, 2);
    assert.deepEqual(await readFile(statePath), bytes);

    const usage = formatMigrationResult(forced);
    assert.ok(usage.includes('--force'));
  });
});

test('a clean copy without node_modules exits 1 with the npm ci hint before any lock', async () => {
  await withTempDir(async (dir) => {
    for (const name of [
      'migrate-state.mjs',
      'state-store.mjs',
      'intent-model.mjs',
      'validate-state.mjs',
      'roadmap-model.mjs',
      'validate-schema-runner.mjs',
    ]) {
      await copyFile(
        fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)),
        path.join(dir, name),
      );
    }
    const statePath = path.join(dir, 'state.json');
    await copyFile(fileURLToPath(fixture01), statePath);
    const before = await readFile(statePath);

    const child = spawn(process.execPath, [path.join(dir, 'migrate-state.mjs'), statePath], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`missing-deps child timed out: ${stderr}`));
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
    const output = `${stdout}\n${stderr}`;
    assert.equal(exitCode, 1, output);
    assert.match(output, /npm ci/i);
    assert.match(output, /extracted Skill directory/i);
    assert.match(output, /dependency_unavailable/);
    assert.deepEqual(await readFile(statePath), before);
    await assert.rejects(
      readFile(`${statePath}${LOCK_SUFFIX}`),
      (error) => error.code === 'ENOENT',
    );
    await assert.rejects(
      readFile(`${statePath}${MIGRATION_OUTPUT_SUFFIX}`),
      (error) => error.code === 'ENOENT',
    );
  });
});

test('in-place migration report has no invented test execution or runtime observation', async () => {
  await withTempDir(async (dir) => {
    const { statePath } = await writeFixture(dir, 'legacy.json', fixture01);
    const result = await runMigrationCli([statePath, '--in-place'], { clock });
    assert.equal(result.ok, true);
    const text = formatMigrationResult(result);
    assert.ok(text.includes('added this run: confirmed claims 0, decisions 0, test executions 0, runtime observations 0'));
    assert.ok(text.includes('legacy confirmed decisions awaiting alignment: 1'));
    assert.ok(text.includes('backup:'));
  });
});
