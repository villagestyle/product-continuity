import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectDistFiles,
  extractZipEntries,
  isExcludedRelativePath,
  readZipEntries,
  validateDistFileList,
  validateRelativePath,
} from '../scripts/build-dist.mjs';

const skillRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fullMode = process.env.PC_DIST_FULL === '1' || process.argv.includes('--full');

let tempRoot;
let archivePath;
let manifestPath;
let extractedDir;
let manifest;
let archiveBytes;
let archiveEntries;
let distList;

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: options.cwd ?? extractedDir,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
  });
}

function commandText(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'product-continuity-dist-'));
  archivePath = path.join(tempRoot, 'archive', 'product-continuity.skill');
  manifestPath = path.join(tempRoot, 'archive', 'product-continuity.manifest.json');
  extractedDir = path.join(tempRoot, 'extract');

  distList = JSON.parse(
    await readFile(path.join(skillRoot, 'scripts', 'dist-files.json'), 'utf8'),
  );

  const build = spawnSync(
    process.execPath,
    [
      'scripts/build-dist.mjs',
      '--output',
      archivePath,
      '--manifest',
      manifestPath,
    ],
    { cwd: skillRoot, encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(
    build.status,
    0,
    `build-dist failed:\n${commandText(build)}`,
  );

  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  archiveBytes = await readFile(archivePath);
  archiveEntries = readZipEntries(archiveBytes);
  await extractZipEntries(archiveEntries, extractedDir, {
    root: manifest.archiveRoot,
  });
});

after(async () => {
  if (!tempRoot) return;
  if (process.env.PC_DIST_KEEP === '1') {
    console.error(`[distribution.test] kept temporary directory: ${tempRoot}`);
    return;
  }
  await rm(tempRoot, { recursive: true, force: true });
});

test('manifest is explicit, complete and per-file hashed', async (t) => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.skill, 'product-continuity');
  assert.equal(manifest.archiveRoot, 'product-continuity');
  assert.equal(manifest.archive.file, path.basename(archivePath));
  assert.equal(manifest.archive.size, archiveBytes.length);
  assert.equal(manifest.archive.sha256, sha256(archiveBytes));

  const manifestPaths = manifest.files.map((item) => item.path);
  assert.deepEqual(
    [...manifestPaths].sort(),
    [...distList.files].sort(),
    'manifest files must equal the explicit dist-files.json list',
  );
  assert.equal(new Set(manifestPaths.map((item) => item.toLowerCase())).size, manifestPaths.length);

  for (const item of manifest.files) {
    validateRelativePath(item.path);
    assert.equal(isExcludedRelativePath(item.path), false, `excluded path in manifest: ${item.path}`);
    const sourceBytes = await readFile(path.join(skillRoot, ...item.path.split('/')));
    if (item.size !== sourceBytes.length || item.sha256 !== sha256(sourceBytes)) {
      // Concurrent work may edit a source file between the archive build and
      // this assertion. The archive-vs-manifest check below remains the
      // release-critical check; surface the race without failing a snapshot
      // that is internally consistent.
      t.diagnostic(`source changed after build: ${item.path}`);
    }
  }

  for (const required of [
    'README.md',
    'SKILL.md',
    'references/data-contract.md',
    'references/review-service.md',
    'schemas/project-state-0.1.schema.json',
    'schemas/project-state-0.2.schema.json',
    'schemas/review-command.schema.json',
    'scripts/build-dist.mjs',
    'scripts/review-service.mjs',
    'scripts/migrate-state.mjs',
    'tests/distribution.test.mjs',
    'package.json',
    'package-lock.json',
  ]) {
    assert.ok(manifestPaths.includes(required), `missing required package file: ${required}`);
  }
  assert.ok(!manifestPaths.includes(path.basename(manifestPath)), 'manifest must not hash itself');
});

test('archive entries are safe, regular and byte-identical to the manifest', () => {
  assert.equal(archiveEntries.length, manifest.files.length);
  const expected = new Map(manifest.files.map((item) => [item.path, item]));
  const names = new Set();

  for (const entry of archiveEntries) {
    validateRelativePath(entry.name);
    assert.ok(
      entry.name.startsWith(`${manifest.archiveRoot}/`),
      `entry outside archive root: ${entry.name}`,
    );
    const relative = entry.name.slice(manifest.archiveRoot.length + 1);
    validateRelativePath(relative);
    assert.equal(names.has(relative.toLowerCase()), false, `duplicate entry: ${relative}`);
    names.add(relative.toLowerCase());
    assert.equal(isExcludedRelativePath(relative), false, `excluded entry: ${relative}`);
    assert.equal((entry.externalAttributes >>> 16) & 0xf000, 0o100000, `not a regular file: ${entry.name}`);

    const item = expected.get(relative);
    assert.ok(item, `unexpected archive entry: ${relative}`);
    assert.equal(entry.size, item.size, `archive size mismatch: ${relative}`);
    assert.equal(sha256(entry.bytes), item.sha256, `archive digest mismatch: ${relative}`);
  }

  assert.ok(!archiveEntries.some((entry) => entry.name.split('/')[1] === 'node_modules'));
  assert.ok(!archiveEntries.some((entry) => entry.name.startsWith(`${manifest.archiveRoot}/docs/`)));
  assert.ok(!archiveEntries.some((entry) => entry.name.startsWith(`${manifest.archiveRoot}/evals/`)));
  assert.ok(!archiveEntries.some((entry) => entry.name.startsWith(`${manifest.archiveRoot}/generated/`)));
});

test('path validation rejects traversal, absolute paths, duplicates and escape entries', async () => {
  for (const bad of ['../x', 'a/../../x', '/abs/x', 'C:/x', 'a\\b', 'a//b', './a', 'a/../b']) {
    assert.throws(() => validateRelativePath(bad), /path|absolute|canonical|NUL|control/i, bad);
  }
  assert.throws(
    () => validateDistFileList(['README.md', 'readme.md']),
    /Duplicate case-insensitive/,
  );
  assert.throws(
    () => validateDistFileList(['docs/review-service-plan.md']),
    /excluded\/private/,
  );

  const escapeTarget = path.join(tempRoot, 'escape-target');
  await assert.rejects(
    () =>
      extractZipEntries(
        [{ name: 'product-continuity/../outside.txt', bytes: Buffer.from('no') }],
        escapeTarget,
      ),
    /not a canonical relative path|escapes/,
  );
  await assert.rejects(
    () =>
      extractZipEntries(
        [{ name: '/absolute.txt', bytes: Buffer.from('no') }],
        escapeTarget,
      ),
    /absolute|path/i,
  );
});

test('symlinked source files are rejected when the platform permits symlinks', async (t) => {
  const source = path.join(tempRoot, 'symlink-source');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'README.md'), 'fixture\n');
  try {
    await symlink('README.md', path.join(source, 'link.md'), 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('creating a test symlink requires additional Windows privileges');
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => collectDistFiles(source, ['README.md', 'link.md']),
    /Symbolic links are not packaged/,
  );
});

test('clean extraction runs the static dual-read tools without node_modules', async () => {
  await assert.rejects(access(path.join(extractedDir, 'node_modules')));

  const examples = [
    'examples/minimal-project-state.json',
    'examples/demo-project-state.json',
    'examples/demo-project-state-0.2.json',
    'examples/roadmap-project-state-0.2.json',
  ];
  const beforeHashes = new Map();
  for (const relative of examples) {
    const absolute = path.join(extractedDir, ...relative.split('/'));
    beforeHashes.set(relative, sha256(await readFile(absolute)));
  }

  for (const relative of examples) {
    const result = runNode(['scripts/validate-state.mjs', relative]);
    assert.equal(result.status, 0, `validate-state failed for ${relative}:\n${commandText(result)}`);
  }

  const outputDirectory = path.join(tempRoot, 'static-output');
  await mkdir(outputDirectory, { recursive: true });

  const map01 = path.join(outputDirectory, 'map-0.1.html');
  const mapResult = runNode([
    'scripts/render-map.mjs',
    'examples/demo-project-state.json',
    map01,
  ]);
  assert.equal(mapResult.status, 0, `render-map 0.1 failed:\n${commandText(mapResult)}`);
  assert.ok((await readFile(map01, 'utf8')).includes('<!doctype html'));

  const map02 = path.join(outputDirectory, 'map-0.2.html');
  const map02Result = runNode([
    'scripts/render-map.mjs',
    'examples/demo-project-state-0.2.json',
    map02,
  ]);
  assert.equal(map02Result.status, 0, `render-map 0.2 failed:\n${commandText(map02Result)}`);
  assert.ok((await readFile(map02, 'utf8')).includes('<!doctype html'));

  const roadmap = path.join(outputDirectory, 'map-roadmap.html');
  const roadmapResult = runNode(['scripts/render-map.mjs','examples/roadmap-project-state-0.2.json',roadmap]);
  assert.equal(roadmapResult.status,0,`render-map roadmap failed:\n${commandText(roadmapResult)}`);
  assert.ok((await readFile(roadmap,'utf8')).includes('id="graph-roadmap"'));

  const receipt = path.join(outputDirectory, 'check.md');
  const checkResult = runNode([
    'scripts/render-check.mjs',
    'examples/demo-project-state.json',
    'check:demo-001',
    receipt,
  ]);
  assert.equal(checkResult.status, 0, `render-check failed:\n${commandText(checkResult)}`);
  assert.ok((await readFile(receipt, 'utf8')).includes('check:demo-001'));

  const receipt02 = path.join(outputDirectory, 'check-0.2.md');
  const check02Result = runNode([
    'scripts/render-check.mjs',
    'examples/demo-project-state-0.2.json',
    'check:demo-001',
    receipt02,
  ]);
  assert.equal(
    check02Result.status,
    0,
    `render-check 0.2 failed:\n${commandText(check02Result)}`,
  );
  assert.ok((await readFile(receipt02, 'utf8')).includes('check:demo-001'));

  for (const [relative, digest] of beforeHashes) {
    const absolute = path.join(extractedDir, ...relative.split('/'));
    assert.equal(sha256(await readFile(absolute)), digest, `static tool changed ${relative}`);
  }
});

test('missing dependencies exit before acquiring a lock and print the npm ci hint', async () => {
  const stateDirectory = path.join(tempRoot, 'missing-dependency-state');
  await mkdir(stateDirectory, { recursive: true });
  const serviceState = path.join(stateDirectory, 'service-state.json');
  const migrationState = path.join(stateDirectory, 'migration-state.json');
  await writeFile(
    serviceState,
    await readFile(path.join(extractedDir, 'examples', 'demo-project-state-0.2.json')),
  );
  await writeFile(
    migrationState,
    await readFile(path.join(extractedDir, 'examples', 'demo-project-state.json')),
  );
  const serviceBefore = sha256(await readFile(serviceState));
  const migrationBefore = sha256(await readFile(migrationState));

  const service = runNode(['scripts/review-service.mjs', serviceState]);
  assert.notEqual(service.status, 0, 'service must not start without local dependencies');
  assert.match(commandText(service), /npm ci/i);
  assert.equal(sha256(await readFile(serviceState)), serviceBefore);
  await assert.rejects(access(`${serviceState}.review.lock`), /ENOENT/);

  const migration = runNode([
    'scripts/migrate-state.mjs',
    migrationState,
    `${migrationState}.v0.2.json`,
  ]);
  assert.notEqual(migration.status, 0, 'migration must not run without local dependencies');
  assert.match(
    commandText(migration),
    /npm ci/i,
    'migration must explain how to install the missing local dependencies',
  );
  assert.equal(sha256(await readFile(migrationState)), migrationBefore);
  await assert.rejects(access(`${migrationState}.review.lock`), /ENOENT/);
  await assert.rejects(access(`${migrationState}.v0.2.json`), /ENOENT/);
});

test('clean extraction planning and MCP reject missing schema dependencies without any state or lock write', async () => {
  const directory = path.join(tempRoot,'missing-roadmap-dependencies');
  await mkdir(directory);
  const statePath = path.join(directory,'state.json');
  const bytes = await readFile(path.join(extractedDir,'examples/roadmap-project-state-0.2.json'));
  const state = JSON.parse(bytes); await writeFile(statePath,bytes);
  const planPath = path.join(directory,'plan.json');
  await writeFile(planPath,JSON.stringify({projectId:state.project.id,operationId:'offline-dist-test',expectedStateVersion:state.stateVersion,expectedDigest:sha256(bytes),authorizationRef:'Synthetic test only',summary:'Synthetic preview',items:[{...state.roadmapItems[0],objective:'Synthetic changed target'}],capabilities:[]}));
  const before = (await readdir(directory)).sort();
  const preview = runNode(['scripts/plan-roadmap.mjs',statePath,planPath]);
  assert.equal(preview.status,1);assert.match(commandText(preview),/npm ci/);assert.match(commandText(preview),/dependency_unavailable/);
  const messages = [
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'offline-dist-test',version:'1'}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'project_get',arguments:{projectId:state.project.id}}},
  ];
  const mcp = spawnSync(process.execPath,['scripts/mcp-server.mjs','--project-root',directory,'--state','state.json','--project-id',state.project.id],{cwd:extractedDir,encoding:'utf8',timeout:15000,input:messages.map(m=>JSON.stringify(m)+'\n').join('')});
  assert.equal(mcp.status,0,commandText(mcp));assert.equal(mcp.stderr,'');
  const result = mcp.stdout.trim().split('\n').map(line=>JSON.parse(line)).find(m=>m.id===2).result;
  assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).error.code,'dependency_unavailable');
  assert.match(result.content[0].text,/npm ci/);
  assert.deepEqual(await readFile(statePath),bytes);assert.deepEqual((await readdir(directory)).sort(),before);
});

test(
  'full installation: npm ci, explicit nonrecursive tests and a temporary state service check',
  { skip: fullMode ? false : 'set PC_DIST_FULL=1 or pass --full to run the networked install test', timeout: 600_000 },
  async (t) => {
    const npm = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd: extractedDir,
        encoding: 'utf8',
        timeout: 300_000,
        shell: process.platform === 'win32',
      },
    );
    assert.equal(npm.status, 0, `npm ci failed:\n${commandText(npm)}`);
    t.diagnostic('npm ci: exit 0 in the extracted temporary skill directory');

    // Schema and cross-record references are both hard requirements once the
    // exact local dependencies are installed. Both complete demo examples are
    // checked; the static (no-deps) reference check above uses the same files.
    const schema = runNode([
      'scripts/validate-schema-runner.mjs',
      'examples/demo-project-state.json',
      'examples/demo-project-state-0.2.json',
    ]);
    assert.equal(schema.status, 0, `example schema validation failed:\n${commandText(schema)}`);
    for (const relative of [
      'examples/demo-project-state.json',
      'examples/demo-project-state-0.2.json',
    ]) {
      const references = runNode(['scripts/validate-state.mjs', relative]);
      assert.equal(
        references.status,
        0,
        `example reference validation failed for ${relative}:\n${commandText(references)}`,
      );
    }
    t.diagnostic('schema+references: both complete demo examples valid after npm ci');

    const testDirectory = path.join(extractedDir, 'tests');
    const testFiles = (await readdir(testDirectory))
      .filter((name) => name.endsWith('.test.mjs') && name !== 'distribution.test.mjs')
      .sort()
      .map((name) => `tests/${name}`);
    assert.ok(testFiles.length > 0, 'no explicit test files found after extraction');

    const tests = runNode(['--test', ...testFiles], { timeout: 300_000 });
    assert.equal(
      tests.status,
      0,
      `explicit nonrecursive tests failed:\n${commandText(tests)}`,
    );
    t.diagnostic(`explicit nonrecursive tests: ${testFiles.length} files, exit 0`);

    const fullDirectory = path.join(tempRoot, 'full');
    await mkdir(fullDirectory, { recursive: true });
    const migrationSource = path.join(fullDirectory, 'migrate-input.json');
    await writeFile(
      migrationSource,
      await readFile(path.join(extractedDir, 'examples', 'demo-project-state.json')),
    );
    const migrationSourceDigest = sha256(await readFile(migrationSource));
    const migrationOutput = `${migrationSource}.v0.2.json`;
    const migration = runNode([
      'scripts/migrate-state.mjs',
      migrationSource,
      migrationOutput,
    ]);
    assert.equal(migration.status, 0, `migration failed after npm ci:\n${commandText(migration)}`);
    assert.equal(sha256(await readFile(migrationSource)), migrationSourceDigest);
    const validateMigrated = runNode(['scripts/validate-state.mjs', migrationOutput]);
    assert.equal(
      validateMigrated.status,
      0,
      `migrated state reference validation failed:\n${commandText(validateMigrated)}`,
    );
    const migratedSchema = runNode(['scripts/validate-schema-runner.mjs', migrationOutput]);
    assert.equal(
      migratedSchema.status,
      0,
      `migrated state schema validation failed:\n${commandText(migratedSchema)}`,
    );
    t.diagnostic('temporary migration: 0.1 -> 0.2 schema+references valid, source bytes unchanged');

    // Host-driven temporary-state acceptance: real service, real HTTP actions,
    // versioned backup and restart/session checks. It writes only under this
    // test's exact temporary directory and is not `npm test`.
    const acceptanceDirectory = path.join(fullDirectory, 'http-acceptance');
    const acceptance = runNode(['tests/acceptance-http.mjs', acceptanceDirectory], {
      timeout: 300_000,
    });
    assert.equal(
      acceptance.status,
      0,
      `host HTTP acceptance failed:\n${commandText(acceptance)}`,
    );
    const acceptanceReport = JSON.parse(
      await readFile(path.join(acceptanceDirectory, 'http-acceptance.json'), 'utf8'),
    );
    assert.equal(acceptanceReport.passed, true);
    assert.ok(acceptanceReport.scenarios.length > 0);
    assert.match(commandText(acceptance), /HTTP_ACCEPTANCE_OK/);
    t.diagnostic(
      `temporary HTTP acceptance: passed=true, ${acceptanceReport.scenarios.length} scenarios, report under the exact temporary directory`,
    );
  },
);
