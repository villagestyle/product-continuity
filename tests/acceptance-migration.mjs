#!/usr/bin/env node
// Host acceptance of migration write boundaries, using saved simulated fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runMigrationCli } from '../scripts/migrate-state.mjs';
import { validateStateSchema } from '../scripts/validate-schema-runner.mjs';
import { validateStateReferences } from '../scripts/validate-state.mjs';

const digest = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export async function runMigrationAcceptance(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const directory = await mkdtemp(join(outputDirectory, 'migration-state-'));
  const fixtureBytes = await readFile(new URL('./fixtures/state-0.1-shared-decision.json', import.meta.url));
  const sourceState = JSON.parse(fixtureBytes);
  const source = join(directory, 'shared-legacy.json');
  await writeFile(source, fixtureBytes);
  const copied = await runMigrationCli([source]);
  assert.equal(copied.ok, true, JSON.stringify(copied));
  assert.equal(copied.commitStatus, 'verified');
  assert.deepEqual(await readFile(source), fixtureBytes);
  const outputBytes = await readFile(copied.outputPath);
  const output = JSON.parse(outputBytes);
  assert.deepEqual(validateStateSchema(output), []);
  assert.deepEqual(validateStateReferences(output), []);
  assert.equal(output.migration.sourceDigest, digest(fixtureBytes));
  assert.equal(output.intentClaims.filter((claim) => claim.status === 'confirmed').length, 0);
  assert.equal(output.reviews.length, 0);
  assert.deepEqual(output.evidence, sourceState.evidence);
  assert.deepEqual(output.checks, sourceState.checks);
  assert.deepEqual(output.edges, sourceState.edges);
  assert.deepEqual(output.baselines, sourceState.baselines);
  assert.deepEqual(output.decisions.map(({ recordVersion, ...rest }) => rest), sourceState.decisions);
  for (const node of sourceState.nodes) assert.deepEqual(output.nodes.find((item) => item.id === node.id).legacy.snapshot, node);
  for (const node of sourceState.nodes.filter((item) => item.status === 'retired')) assert.equal(output.intentClaims.filter((claim) => claim.nodeId === node.id).length, 0);
  const duplicate = await runMigrationCli([source]);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.outcome, 'target_exists');
  assert.deepEqual(await readFile(copied.outputPath), outputBytes);
  const filesBeforeNoOp = await readdir(directory);
  const noOp = await runMigrationCli([copied.outputPath]);
  assert.equal(noOp.ok, true);
  assert.equal(noOp.outcome, 'no_op');
  assert.equal(noOp.commitStatus, 'not_committed');
  assert.deepEqual(await readdir(directory), filesBeforeNoOp);
  const inPlacePath = join(directory, 'in-place-legacy.json');
  await writeFile(inPlacePath, fixtureBytes);
  const inPlace = await runMigrationCli([inPlacePath, '--in-place']);
  assert.equal(inPlace.ok, true, JSON.stringify(inPlace));
  assert.equal(inPlace.commitStatus, 'verified');
  assert.deepEqual(await readFile(inPlace.backupPath), fixtureBytes);
  assert.equal(JSON.parse(await readFile(inPlacePath)).schemaVersion, '0.2');
  assert.ok(!(await readdir(directory)).some((file) => file.endsWith('.review.lock')));
  const report = {
    kind: 'host-migration-acceptance', generatedAt: new Date().toISOString(), passed: true,
    environment: { node: process.version, platform: process.platform, filesystem: process.platform === 'win32' ? 'NTFS' : 'not characterized' },
    scenarios: [
      { scenarioId: 'M01/M02/M03', passed: true, expectedCommitStatus: 'verified', actualCommitStatus: copied.commitStatus, beforeDigest: digest(fixtureBytes), afterDigest: digest(outputBytes), exitCode: copied.exitCode, note: 'Shared legacy text, provenance and complete node snapshots retained; no automatic confirmation.' },
      { scenarioId: 'M04/existing-output', passed: true, expectedCommitStatus: 'not_committed', actualCommitStatus: duplicate.commitStatus, beforeDigest: digest(outputBytes), afterDigest: digest(await readFile(copied.outputPath)), exitCode: duplicate.exitCode },
      { scenarioId: 'M04/no-op', passed: true, expectedCommitStatus: 'not_committed', actualCommitStatus: noOp.commitStatus, beforeDigest: digest(outputBytes), afterDigest: digest(outputBytes), exitCode: noOp.exitCode },
      { scenarioId: 'M04/in-place-backup', passed: true, expectedCommitStatus: 'verified', actualCommitStatus: inPlace.commitStatus, beforeDigest: digest(fixtureBytes), afterDigest: digest(await readFile(inPlacePath)), exitCode: inPlace.exitCode },
    ],
    syntheticStateLocation: directory, added: { confirmedClaims: 0, decisions: 0, testExecutions: 0, runtimeObservations: 0 },
  };
  await writeFile(join(outputDirectory, 'migration-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runMigrationAcceptance(resolve(process.argv[2] || join(tmpdir(), 'product-continuity-acceptance')));
  console.log('MIGRATION_ACCEPTANCE_OK: ' + report.scenarios.length + ' scenarios; copy/in-place/no-op; full legacy retained; no automatic product confirmation.');
}
