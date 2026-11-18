import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative) => fs.readFile(path.join(skillRoot, relative), 'utf8');

test('SKILL stays under the line bound and exposes the progress/resume workflow', async () => {
  const skill = await read('SKILL.md');
  assert.ok(skill.split(/\r?\n/).length < 500);
  assert.match(skill, /progress-resume\.md/);
  assert.match(skill, /Feature progress and resume/);
  assert.match(skill, /尚无续接记录/);
  assert.match(skill, /规划未记录/);
  assert.match(skill, /nextActions` are descriptions/);
  assert.match(skill, /new session cannot read/i);
  assert.match(skill, /separate state-write\s+authorization/i);
});

test('progress-resume reference defines honest status language, pending handoff and non-authorization', async () => {
  const reference = await read('references/progress-resume.md');
  assert.ok(reference.split(/\r?\n/).length > 300);
  assert.match(reference, /^## Contents$/m);
  for (const status of [
    'unchanged',
    'changed',
    'unverified_no_digest',
    'unavailable',
    'no_checkpoint',
  ]) {
    assert.ok(reference.includes(status), `missing status ${status}`);
  }
  assert.match(reference, /尚无续接记录/);
  assert.match(reference, /规划未记录/);
  assert.match(reference, /续接依据无法比较/);
  assert.match(reference, /nextActions.*never execute/is);
  assert.match(reference, /pending handoff/i);
  assert.match(reference, /cannot read it/i);
  assert.match(reference, /does not prove/i);
});

test('data contract defines the checkpoint record, limits, receipts and fingerprint semantics', async () => {
  const contract = await read('references/data-contract.md');
  assert.match(contract, /^## 7\.3 Feature progress checkpoints/m);
  assert.match(contract, /featureCheckpoints/);
  assert.match(contract, /MAX_FEATURE_CHECKPOINTS/);
  assert.match(contract, /MAX_CHECKPOINT_BYTES/);
  assert.match(contract, /local_feature_checkpoint/);
  assert.match(contract, /contextFingerprintVersion: 1/);
  assert.match(contract, /unverified_no_digest/);
  assert.match(contract, /basis\.refs/);
  assert.match(contract, /sourceSnapshots/);
  assert.match(contract, /delivery\?: CheckpointDelivery/);
  assert.match(contract, /CheckpointDelivery/);
  assert.match(contract, /delivery-blocking/);
});

test('MCP contract documents the final progress shapes, limits and explicit overflow', async () => {
  const contract = await read('references/mcp-contract.md');
  assert.match(contract, /featureProgress/);
  assert.match(contract, /maxFeatureCheckpoints: 200/);
  assert.match(contract, /maxCheckpointBasisRecords: 300/);
  assert.match(contract, /result_too_large/);
  assert.match(contract, /truncated: boolean/);
  assert.match(contract, /basisRecords/);
  assert.match(contract, /workDone\[\]\.basisRefs/);
  assert.match(contract, /remaining\[\]\.basisRefs/);
  assert.match(contract, /checkpointIsNotReview: true/);
  assert.equal(contract.includes('basisClosure'), false);
});

test('README documents the offline checkpoint command and the read-only boundary', async () => {
  const readme = await read('README.md');
  assert.match(readme, /record-feature-checkpoint\.mjs/);
  assert.match(readme, /Feature 进度与断点续接/);
  assert.match(readme, /尚无续接记录/);
  assert.match(readme, /规划未记录/);
  assert.match(readme, /context\.changed/);
  assert.match(readme, /进度回填待处理|pending/);
});

test('delivery-stage docs stay consistent across progress-resume, data contract and MCP contract', async () => {
  const reference = await read('references/progress-resume.md');
  assert.match(reference, /### 7\.1 Delivery stages/);
  assert.match(reference, /按保存的剩余事项/);
  assert.match(reference, /按保存的交付说明/);
  assert.match(reference, /需复核/);
  assert.match(reference, /状态待补充/);
  assert.match(reference, /optional `delivery`/);
  const contract = await read('references/data-contract.md');
  assert.match(contract, /type CheckpointDelivery/);
  assert.match(contract, /delivery\?: CheckpointDelivery/);
  assert.match(contract, /delivery-blocking/);
  assert.match(contract, /test_execution/);
  assert.match(contract, /runtime_observation/);
  const mcp = await read('references/mcp-contract.md');
  assert.match(mcp, /FeatureDeliveryReading/);
  assert.match(mcp, /deliveryIsNotAcceptance: true/);
  assert.match(mcp, /deliveryIsNotReleaseAuthorization: true/);
  assert.match(mcp, /delivery\.basisRefs/);
});

test('eval definitions keep the original 11 and add 12 deterministic progress scenarios', async () => {
  const catalog = JSON.parse(await read('evals/evals.json'));
  assert.equal(catalog.version, '0.2');
  assert.equal(catalog.evals.length, 23);
  assert.deepEqual(catalog.evals.map((item) => item.id), Array.from({ length: 23 }, (_, index) => index + 1));
  for (const item of catalog.evals) {
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.prompt, 'string');
    assert.equal(typeof item.expected_output, 'string');
    assert.ok(Array.isArray(item.files));
    assert.ok(Array.isArray(item.expectations));
    if (item.id >= 12) assert.ok(item.expectations.length >= 5);
  }
  const byId = new Map(catalog.evals.map((item) => [item.id, item]));
  assert.match(byId.get(13).prompt, /state v9/);
  assert.match(byId.get(13).prompt, /actor `agent`/);
  assert.match(byId.get(13).prompt, /goal 'import a CSV file/);
  assert.match(byId.get(14).prompt, /--output \.\/out\/report\.csv/);
  assert.match(byId.get(20).prompt, /state v12/);
  assert.match(byId.get(20).prompt, /sha256:[a-f0-9]{64}/);
  for (const id of [
    'capability:import',
    'capability:sharing',
    'capability:reader',
    'capability:archive',
    'checkpoint:ck-import-02',
    'checkpoint:ck-reader-01',
    'checkpoint:ck-archive-01',
    'roadmap:rm-import',
    'roadmap:rm-sharing',
  ]) {
    assert.ok(byId.get(22).prompt.includes(id), `eval 22 missing ${id}`);
  }
  assert.match(byId.get(23).expected_output, /separate isolated A\/B run/);
});
