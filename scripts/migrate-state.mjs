/**
 * Pure 0.1 -> 0.2 migration plus the explicit persisted CLI.
 *
 * migrateState() stays a pure function: it validates, builds and fully
 * validates the 0.2 object in memory and never touches the filesystem. The
 * CLI below is a thin wrapper around scripts/state-store.mjs so that locks,
 * raw-byte digests, exclusive copy creation and verified replacement follow
 * the same rules as the review service.
 */

import { pathToFileURL } from 'node:url';
import { validateStateReferences, validateStateReferences01 } from './validate-state.mjs';
import {
  INTENT_NODE_KINDS,
  canonicalStringify,
  digestValue,
  deriveNodeIntentSummary,
  isSha256Digest,
} from './intent-model.mjs';
import {
  DEFAULT_MAX_STATE_BYTES,
  StoreError,
  acquireStateLocks,
  assertStateLocks,
  canonicalizeStatePath,
  commitStateBytes,
  createIoAdapter,
  readStateFile,
  releaseStateLocks,
  sha256Bytes,
  validateFullState,
} from './state-store.mjs';

export const MIGRATION_TOOL_VERSION = '0.2.0';
export const MIGRATION_OUTPUT_SUFFIX = '.v0.2.json';

let stateSchemaRunner = null;
let stateSchemaRunnerError = null;
try {
  stateSchemaRunner = await import('./validate-schema-runner.mjs');
} catch (error) {
  stateSchemaRunnerError = error;
}

const DEPENDENCY_HINT =
  'Schema validation dependencies are unavailable; run npm ci in the extracted Skill directory.';

function validateStateSchema(state) {
  if (!stateSchemaRunner) throw new Error(DEPENDENCY_HINT);
  return stateSchemaRunner.validateStateSchema(state);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function readTimestamp(clock) {
  const value = typeof clock === 'function' ? clock() : (clock ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('clock must produce a valid Date or date-time value');
  }
  return date.toISOString();
}

function emptyReport(overrides = {}) {
  return {
    fromSchemaVersion: null,
    toSchemaVersion: null,
    fromStateVersion: null,
    toStateVersion: null,
    sourceDigest: null,
    migratedAt: null,
    generatedCandidateClaimIds: [],
    legacyDecisionIds: [],
    legacyConfirmedDecisionIds: [],
    legacyRetiredNodeIds: [],
    unclassifiedMaterialNodeIds: [],
    addedClaims: 0,
    addedConfirmedClaims: 0,
    addedDecisions: 0,
    addedTestExecutions: 0,
    addedRuntimeObservations: 0,
    warnings: [],
    ...overrides,
  };
}

function failure(outcome, errors, extra = {}) {
  return {
    ok: false,
    outcome,
    state: null,
    fromSchemaVersion: extra.fromSchemaVersion ?? null,
    report: emptyReport(extra.report ?? {}),
    errors,
  };
}

/**
 * Migrate a 0.1 state object to a fully validated 0.2 state object.
 *
 * @param {unknown} state
 * @param {{
 *   clock?: (() => Date|string) | Date | string,
 *   sourceDigest?: string,
 *   toolVersion?: string
 * }} [options]
 *   clock is read exactly once for all new timestamps. sourceDigest should be
 *   the sha256 of the original file bytes; when omitted, the canonical JSON
 *   digest of the parsed state is used and a warning is recorded.
 * @returns {{
 *   ok: boolean,
 *   outcome: 'migrated'|'no_op'|'unsupported_version'|'invalid_input'|'invalid_output'|'dependency_unavailable',
 *   state: object|null,
 *   fromSchemaVersion: string|null,
 *   report: {
 *     fromSchemaVersion: string|null,
 *     toSchemaVersion: string|null,
 *     fromStateVersion: number|null,
 *     toStateVersion: number|null,
 *     sourceDigest: string|null,
 *     migratedAt: string|null,
 *     generatedCandidateClaimIds: string[],
 *     legacyDecisionIds: string[],
 *     legacyConfirmedDecisionIds: string[],
 *     legacyRetiredNodeIds: string[],
 *     unclassifiedMaterialNodeIds: string[],
 *     addedClaims: number,
 *     addedConfirmedClaims: number,
 *     addedDecisions: number,
 *     addedTestExecutions: number,
 *     addedRuntimeObservations: number,
 *     warnings: string[]
 *   },
 *   errors: string[]
 * }}
 */
export function migrateState(state, options = {}) {
  if (!stateSchemaRunner) {
    return failure('dependency_unavailable', [DEPENDENCY_HINT]);
  }
  if (!isRecord(state)) {
    return failure('invalid_input', ['state: expected an object']);
  }

  if (state.schemaVersion === '0.2') {
    return {
      ok: true,
      outcome: 'no_op',
      state: null,
      fromSchemaVersion: '0.2',
      report: emptyReport({
        fromSchemaVersion: '0.2',
        toSchemaVersion: '0.2',
        fromStateVersion: typeof state.stateVersion === 'number' ? state.stateVersion : null,
        toStateVersion: typeof state.stateVersion === 'number' ? state.stateVersion : null,
        warnings: ['State is already 0.2; no migration was performed and no second claim set was generated.'],
      }),
      errors: [],
    };
  }

  if (state.schemaVersion !== '0.1') {
    return failure('unsupported_version', [
      `schemaVersion: unsupported version "${String(state.schemaVersion)}"; only 0.1 can be migrated and 0.2 is a no-op`,
    ], { fromSchemaVersion: typeof state.schemaVersion === 'string' ? state.schemaVersion : null });
  }

  const schemaErrors = validateStateSchema(state);
  if (schemaErrors.length) {
    return failure('invalid_input', schemaErrors, { fromSchemaVersion: '0.1' });
  }
  const referenceErrors = validateStateReferences01(state);
  if (referenceErrors.length) {
    return failure('invalid_input', referenceErrors, { fromSchemaVersion: '0.1' });
  }

  for (const node of state.nodes) {
    if (!INTENT_NODE_KINDS.includes(node.kind) && node.status === 'confirmed') {
      return failure('invalid_input', [
        `node ${node.id}: a non-intent node cannot be migrated with confirmed status; 0.2 does not reinterpret it`,
      ], { fromSchemaVersion: '0.1' });
    }
  }

  let migratedAt;
  let sourceDigest;
  const warnings = [];
  try {
    migratedAt = readTimestamp(options.clock);
  } catch (error) {
    return failure('invalid_input', [`clock: ${error.message}`], { fromSchemaVersion: '0.1' });
  }
  if (options.sourceDigest === undefined) {
    try {
      sourceDigest = digestValue(state);
    } catch (error) {
      return failure('invalid_input', [`sourceDigest: ${error.message}`], { fromSchemaVersion: '0.1' });
    }
    warnings.push('sourceDigest was not supplied; the canonical state digest was used instead of the raw file-byte digest.');
  } else if (!isSha256Digest(options.sourceDigest)) {
    return failure('invalid_input', [
      'sourceDigest: expected sha256:<64 lowercase hex>',
    ], { fromSchemaVersion: '0.1' });
  } else {
    sourceDigest = options.sourceDigest;
  }

  const allKnownIds = new Set();
  for (const collection of ['baselines', 'nodes', 'edges', 'evidence', 'decisions', 'checks']) {
    for (const item of state[collection] ?? []) {
      if (isRecord(item) && typeof item.id === 'string') allKnownIds.add(item.id);
    }
  }

  const claims = [];
  const generatedCandidateClaimIds = [];
  const legacyRetiredNodeIds = [];
  const unclassifiedMaterialNodeIds = [];
  const claimIds = new Set();

  let nodes;
  try {
    nodes = state.nodes.map((originalNode) => {
      const node = clone(originalNode);
      const snapshot = clone(originalNode);
      delete node.decisionId;
      node.legacy = { schemaVersion: '0.1', snapshot };

      if (Array.isArray(originalNode.conditions) && originalNode.conditions.length > 0) {
        unclassifiedMaterialNodeIds.push(originalNode.id);
      }

      if (originalNode.kind === 'implementation' || originalNode.kind === 'verification' || originalNode.kind === 'unknown') {
        node.status = originalNode.status;
        return node;
      }

      if (originalNode.status === 'retired') {
        legacyRetiredNodeIds.push(originalNode.id);
        node.status = 'retired';
        return node;
      }

      const claimId = `claim:${originalNode.id}`;
      if (allKnownIds.has(claimId) || claimIds.has(claimId)) {
        throw new Error(`claim ID collision for derived claim "${claimId}"`);
      }
      claimIds.add(claimId);
      allKnownIds.add(claimId);
      generatedCandidateClaimIds.push(claimId);
      claims.push({
        id: claimId,
        nodeId: originalNode.id,
        statement: originalNode.label,
        scope: [],
        conditions: [],
        exceptions: [],
        status: 'candidate',
        origin: 'migration',
        createdAt: migratedAt,
        createdByReviewId: null,
        assessment: {
          disposition: 'unreviewed',
          contentDigest: null,
          reviewedLegacyContext: false,
          reviewId: null,
        },
        governingDecisionId: null,
        retiredByDecisionId: null,
        supersedesClaimIds: [],
        supersededByClaimIds: [],
      });
      node.status = 'candidate';
      return node;
    });
  } catch (error) {
    return failure('invalid_input', [error.message], { fromSchemaVersion: '0.1' });
  }

  const decisions = state.decisions.map((decision) => ({ ...clone(decision), recordVersion: '0.1' }));
  const legacyConfirmedDecisionIds = decisions
    .filter((decision) => decision.status === 'confirmed')
    .map((decision) => decision.id);

  if (legacyConfirmedDecisionIds.length > 0) {
    warnings.push(`${legacyConfirmedDecisionIds.length} legacy confirmed decision(s) remain unaligned to the new claims; no claim was auto-confirmed.`);
  }
  if (legacyRetiredNodeIds.length > 0) {
    warnings.push(`${legacyRetiredNodeIds.length} already-retired intent node(s) were preserved as history and received no active claim.`);
  }
  if (unclassifiedMaterialNodeIds.length > 0) {
    warnings.push(`${unclassifiedMaterialNodeIds.length} node(s) keep conditions as unclassified/historical material; conditions were not copied into intent claims.`);
  }
  if (claims.length > 0) {
    warnings.push(`${claims.length} unreviewed candidate claim(s) were created; none are confirmed.`);
  }
  warnings.push('No review, proposal, confirmed claim, decision, test execution or runtime observation was added.');

  const migrated = {
    schemaVersion: '0.2',
    stateVersion: state.stateVersion + 1,
    project: clone(state.project),
    activeBaselineId: state.activeBaselineId,
    baselines: clone(state.baselines),
    nodes,
    edges: clone(state.edges),
    evidence: clone(state.evidence),
    decisions,
    intentClaims: claims,
    proposals: [],
    reviews: [],
    checks: clone(state.checks),
    migration: {
      fromSchemaVersion: '0.1',
      fromStateVersion: state.stateVersion,
      sourceDigest,
      migratedAt,
      toolVersion: options.toolVersion ?? MIGRATION_TOOL_VERSION,
      warnings,
    },
  };

  // Recompute status with the shared derivation after all claims exist.
  for (const node of migrated.nodes) {
    node.status = deriveNodeIntentSummary(node, migrated.intentClaims).status;
  }

  const outputSchemaErrors = validateStateSchema(migrated);
  if (outputSchemaErrors.length) {
    return failure('invalid_output', outputSchemaErrors, {
      fromSchemaVersion: '0.1',
      report: {
        fromSchemaVersion: '0.1', toSchemaVersion: '0.2', fromStateVersion: state.stateVersion, toStateVersion: migrated.stateVersion,
        sourceDigest, migratedAt, generatedCandidateClaimIds, legacyDecisionIds: decisions.map((decision) => decision.id),
        legacyConfirmedDecisionIds, legacyRetiredNodeIds, unclassifiedMaterialNodeIds, addedClaims: claims.length, warnings,
      },
    });
  }
  const outputReferenceErrors = validateStateReferences(migrated);
  if (outputReferenceErrors.length) {
    return failure('invalid_output', outputReferenceErrors, {
      fromSchemaVersion: '0.1',
      report: {
        fromSchemaVersion: '0.1', toSchemaVersion: '0.2', fromStateVersion: state.stateVersion, toStateVersion: migrated.stateVersion,
        sourceDigest, migratedAt, generatedCandidateClaimIds, legacyDecisionIds: decisions.map((decision) => decision.id),
        legacyConfirmedDecisionIds, legacyRetiredNodeIds, unclassifiedMaterialNodeIds, addedClaims: claims.length, warnings,
      },
    });
  }

  const report = emptyReport({
    fromSchemaVersion: '0.1',
    toSchemaVersion: '0.2',
    fromStateVersion: state.stateVersion,
    toStateVersion: migrated.stateVersion,
    sourceDigest,
    migratedAt,
    generatedCandidateClaimIds,
    legacyDecisionIds: decisions.map((decision) => decision.id),
    legacyConfirmedDecisionIds,
    legacyRetiredNodeIds,
    unclassifiedMaterialNodeIds,
    addedClaims: claims.length,
    addedConfirmedClaims: 0,
    addedDecisions: 0,
    addedTestExecutions: 0,
    addedRuntimeObservations: 0,
    warnings,
  });

  return {
    ok: true,
    outcome: 'migrated',
    state: migrated,
    fromSchemaVersion: '0.1',
    report,
    errors: [],
  };
}

function parseMigrationArguments(argv) {
  let input = null;
  let output = null;
  let inPlace = false;
  for (const arg of argv) {
    if (arg === '--in-place') {
      if (inPlace) throw new Error('--in-place was specified more than once');
      inPlace = true;
    } else if (arg === '--force') {
      throw new Error('--force is not supported; an existing target is never overwritten');
    } else if (typeof arg === 'string' && arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (input === null) {
      input = arg;
    } else if (output === null) {
      output = arg;
    } else {
      throw new Error('Too many path arguments');
    }
  }
  if (!input) {
    throw new Error(
      'Usage: node scripts/migrate-state.mjs <state-0.1.json> [output-0.2.json]\n' +
        '       node scripts/migrate-state.mjs <state-0.1.json> --in-place',
    );
  }
  if (inPlace && output) {
    throw new Error('--in-place does not accept a separate output path');
  }
  return { input, output, inPlace };
}

function zeroAddedCounts() {
  return {
    confirmedClaims: 0,
    decisions: 0,
    testExecutions: 0,
    runtimeObservations: 0,
  };
}

function runtimeAddedCounts(report) {
  return {
    confirmedClaims: report?.addedConfirmedClaims ?? 0,
    decisions: report?.addedDecisions ?? 0,
    testExecutions: report?.addedTestExecutions ?? 0,
    runtimeObservations: report?.addedRuntimeObservations ?? 0,
  };
}

async function statePathExists(io, targetPath) {
  try {
    await io.stat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function failureResult(error, base = {}) {
  if (error instanceof StoreError) {
    return {
      ...base,
      ok: false,
      outcome: error.code,
      commitStatus: error.commitStatus,
      exitCode: 1,
      errors: [error.message],
      details: error.details,
      backupPath: error.details?.backupPath ?? base.backupPath ?? null,
      temporaryPath: error.details?.temporaryPath ?? base.temporaryPath ?? null,
      added: zeroAddedCounts(),
    };
  }
  return {
    ...base,
    ok: false,
    outcome: 'unexpected_error',
    commitStatus: 'not_committed',
    exitCode: 1,
    errors: [error?.message ?? String(error)],
    added: zeroAddedCounts(),
  };
}

/**
 * Persisted migration CLI implementation, callable from tests without spawning
 * a subprocess.
 *
 * @param {string[]} argv
 * @param {{
 *   fs?: object,
 *   clock?: Function|Date|string,
 *   toolVersion?: string,
 *   maxStateBytes?: number,
 *   hooks?: object,
 *   port?: number
 * }} [options]
 */
export async function runMigrationCli(argv, options = {}) {
  const io = createIoAdapter(options.fs);
  const maxStateBytes = options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
  const clock = options.clock ?? (() => new Date());
  const toolVersion = options.toolVersion ?? MIGRATION_TOOL_VERSION;

  let args;
  try {
    args = parseMigrationArguments(argv);
  } catch (error) {
    return {
      ok: false,
      outcome: 'usage_error',
      commitStatus: 'not_committed',
      exitCode: 2,
      errors: [error.message],
      inputPath: null,
      outputPath: null,
      backupPath: null,
      added: zeroAddedCounts(),
    };
  }
  if (!stateSchemaRunner) {
    return {
      ok: false,
      outcome: 'dependency_unavailable',
      commitStatus: 'not_committed',
      exitCode: 1,
      inputPath: null,
      outputPath: null,
      backupPath: null,
      errors: [`${DEPENDENCY_HINT} (${stateSchemaRunnerError?.code ?? 'dependency'})`],
      added: zeroAddedCounts(),
    };
  }

  let inputCanonical;
  let source;
  let sourceState;
  try {
    inputCanonical = await canonicalizeStatePath(args.input, { io, mustExist: true });
    source = await readStateFile(inputCanonical.path, { io, maxStateBytes });
    try {
      sourceState = JSON.parse(source.text);
    } catch (error) {
      return failureResult(
        new StoreError('invalid_input', `Cannot parse the input state as JSON: ${error.message}`, {
          status: 400,
          cause: error,
        }),
        { inputPath: inputCanonical.path },
      );
    }
  } catch (error) {
    return failureResult(error);
  }

  if (sourceState?.schemaVersion === '0.2') {
    const errors = validateFullState(sourceState);
    if (errors.length) {
      return {
        ok: false,
        outcome: 'invalid_input',
        commitStatus: 'not_committed',
        exitCode: 1,
        inputPath: inputCanonical.path,
        outputPath: null,
        backupPath: null,
        errors,
        added: zeroAddedCounts(),
      };
    }
    const noOp = migrateState(sourceState, {
      clock,
      sourceDigest: source.digest,
      toolVersion,
    });
    return {
      ok: true,
      outcome: 'no_op',
      commitStatus: 'not_committed',
      exitCode: 0,
      inputPath: inputCanonical.path,
      outputPath: null,
      backupPath: null,
      sourceDigest: source.digest,
      report: noOp.report,
      warnings: noOp.report.warnings,
      errors: [],
      added: runtimeAddedCounts(noOp.report),
      message: 'State is already 0.2; no file was written and no claim set was regenerated.',
    };
  }

  if (sourceState?.schemaVersion !== '0.1') {
    return {
      ok: false,
      outcome: 'unsupported_version',
      commitStatus: 'not_committed',
      exitCode: 1,
      inputPath: inputCanonical.path,
      outputPath: null,
      backupPath: null,
      sourceDigest: source.digest,
      errors: [
        `schemaVersion: unsupported version "${String(sourceState?.schemaVersion)}"; only 0.1 can be migrated and 0.2 is a no-op`,
      ],
      added: zeroAddedCounts(),
    };
  }

  const migration = migrateState(sourceState, {
    clock,
    sourceDigest: source.digest,
    toolVersion,
  });
  if (!migration.ok) {
    return {
      ok: false,
      outcome: migration.outcome,
      commitStatus: 'not_committed',
      exitCode: 1,
      inputPath: inputCanonical.path,
      outputPath: null,
      backupPath: null,
      sourceDigest: source.digest,
      report: migration.report,
      errors: migration.errors,
      added: zeroAddedCounts(),
    };
  }

  let nextBytes;
  try {
    nextBytes = Buffer.from(`${canonicalStringify(migration.state)}\n`, 'utf8');
  } catch (error) {
    return failureResult(
      new StoreError('state_validation_failed', `Cannot serialise the migrated state: ${error.message}`, {
        status: 500,
        cause: error,
      }),
      { inputPath: inputCanonical.path },
    );
  }
  if (nextBytes.byteLength > maxStateBytes) {
    return {
      ok: false,
      outcome: 'state_too_large',
      commitStatus: 'not_committed',
      exitCode: 1,
      inputPath: inputCanonical.path,
      outputPath: null,
      backupPath: null,
      sourceDigest: source.digest,
      errors: [
        `The migrated state would be ${nextBytes.byteLength} bytes, above the configured limit of ${maxStateBytes} bytes; refusing to write or truncate.`,
      ],
      added: zeroAddedCounts(),
    };
  }
  const nextDigest = sha256Bytes(nextBytes);

  if (args.inPlace) {
    let locks = [];
    try {
      locks = await acquireStateLocks([inputCanonical.path], { io, port: options.port });
      await assertStateLocks(locks, { io });
      const sourceAgain = await readStateFile(inputCanonical.path, { io, maxStateBytes });
      if (sourceAgain.digest !== source.digest) {
        return {
          ok: false,
          outcome: 'source_changed',
          commitStatus: 'not_committed',
          exitCode: 1,
          inputPath: inputCanonical.path,
          outputPath: inputCanonical.path,
          backupPath: null,
          sourceDigest: source.digest,
          currentSourceDigest: sourceAgain.digest,
          errors: ['The source state changed before the in-place replacement; nothing was written.'],
          added: zeroAddedCounts(),
        };
      }
      const commit = await commitStateBytes({
        statePath: inputCanonical.path,
        oldBytes: source.bytes,
        oldDigest: source.digest,
        oldStat: source.stat,
        oldVersion: sourceState.stateVersion,
        nextBytes,
        nextDigest,
        io,
        hooks: options.hooks,
        maxStateBytes,
        lockCheck: () => assertStateLocks(locks, { io }),
        verifyCommitted: (state) => {
          const errors = [];
          if (state.schemaVersion !== '0.2') errors.push('post-read schemaVersion is not 0.2');
          if (state.stateVersion !== migration.state.stateVersion) {
            errors.push('post-read stateVersion does not match the migrated version');
          }
          if (state.migration?.fromSchemaVersion !== '0.1') {
            errors.push('post-read migration.fromSchemaVersion is not 0.1');
          }
          if (state.migration?.sourceDigest !== source.digest) {
            errors.push('post-read migration.sourceDigest does not match the original bytes');
          }
          return errors;
        },
      });
      return {
        ok: true,
        outcome: 'migrated',
        commitStatus: 'verified',
        exitCode: 0,
        inputPath: inputCanonical.path,
        outputPath: inputCanonical.path,
        backupPath: commit.backupPath,
        sourceDigest: source.digest,
        outputDigest: nextDigest,
        directorySync: commit.directorySync,
        renameAttempts: commit.renameAttempts,
        report: migration.report,
        warnings: migration.report.warnings,
        errors: [],
        added: runtimeAddedCounts(migration.report),
      };
    } catch (error) {
      return failureResult(error, {
        inputPath: inputCanonical.path,
        outputPath: inputCanonical.path,
      });
    } finally {
      await releaseStateLocks(locks, { io });
    }
  }

  let targetCanonical;
  try {
    targetCanonical = await canonicalizeStatePath(
      args.output ?? `${inputCanonical.path}${MIGRATION_OUTPUT_SUFFIX}`,
      { io, mustExist: false },
    );
  } catch (error) {
    return failureResult(error, { inputPath: inputCanonical.path });
  }
  if (targetCanonical.identity === inputCanonical.identity) {
    return {
      ok: false,
      outcome: 'output_same_as_input',
      commitStatus: 'not_committed',
      exitCode: 1,
      inputPath: inputCanonical.path,
      outputPath: targetCanonical.path,
      backupPath: null,
      errors: ['Output path resolves to the input state; use --in-place explicitly or choose another output.'],
      added: zeroAddedCounts(),
    };
  }
  if (targetCanonical.exists) {
    return {
      ok: false,
      outcome: 'target_exists',
      commitStatus: 'not_committed',
      exitCode: 1,
      inputPath: inputCanonical.path,
      outputPath: targetCanonical.path,
      backupPath: null,
      errors: ['The output path already exists; migration never overwrites it.'],
      added: zeroAddedCounts(),
    };
  }

  let locks = [];
  try {
    locks = await acquireStateLocks([inputCanonical.path, targetCanonical.path], {
      io,
      port: options.port,
    });
    await assertStateLocks(locks, { io });
    const sourceAgain = await readStateFile(inputCanonical.path, { io, maxStateBytes });
    if (sourceAgain.digest !== source.digest) {
      return {
        ok: false,
        outcome: 'source_changed',
        commitStatus: 'not_committed',
        exitCode: 1,
        inputPath: inputCanonical.path,
        outputPath: targetCanonical.path,
        backupPath: null,
        sourceDigest: source.digest,
        currentSourceDigest: sourceAgain.digest,
        errors: ['The source state changed before the copy was written; no output was created.'],
        added: zeroAddedCounts(),
      };
    }
    if (await statePathExists(io, targetCanonical.path)) {
      return {
        ok: false,
        outcome: 'target_exists',
        commitStatus: 'not_committed',
        exitCode: 1,
        inputPath: inputCanonical.path,
        outputPath: targetCanonical.path,
        backupPath: null,
        errors: ['The output path appeared before the exclusive create; migration never overwrites it.'],
        added: zeroAddedCounts(),
      };
    }

    let handle;
    try {
      handle = await io.open(targetCanonical.path, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        return {
          ok: false,
          outcome: 'target_exists',
          commitStatus: 'not_committed',
          exitCode: 1,
          inputPath: inputCanonical.path,
          outputPath: targetCanonical.path,
          backupPath: null,
          errors: ['The output path already exists; migration never overwrites it.'],
          added: zeroAddedCounts(),
        };
      }
      return failureResult(
        new StoreError('output_open_failed', `Cannot create the output file: ${error.message}`, {
          status: 500,
          cause: error,
          details: { outputPath: targetCanonical.path },
        }),
        { inputPath: inputCanonical.path, outputPath: targetCanonical.path },
      );
    }
    try {
      await handle.writeFile(nextBytes);
      await handle.sync();
    } catch (error) {
      return {
        ok: false,
        outcome: 'output_write_failed',
        commitStatus: 'unknown',
        exitCode: 1,
        inputPath: inputCanonical.path,
        outputPath: targetCanonical.path,
        partialOutputPath: targetCanonical.path,
        backupPath: null,
        sourceDigest: source.digest,
        errors: [`Writing the output failed: ${error.message}`],
        added: zeroAddedCounts(),
      };
    } finally {
      try {
        await handle.close();
      } catch {
        // The following readback decides whether the output is usable.
      }
    }

    let readback;
    let readbackState;
    const readbackErrors = [];
    try {
      readback = await readStateFile(targetCanonical.path, { io, maxStateBytes });
      readbackState = JSON.parse(readback.text);
    } catch (error) {
      readbackErrors.push(`Cannot read back the output: ${error.message}`);
    }
    if (readback && readback.digest !== nextDigest) {
      readbackErrors.push(
        `Output digest ${readback.digest} does not match the migrated bytes ${nextDigest}.`,
      );
    }
    if (readbackState) readbackErrors.push(...validateFullState(readbackState));
    if (readbackErrors.length) {
      return {
        ok: false,
        outcome: 'output_unverified',
        commitStatus: 'unknown',
        exitCode: 1,
        inputPath: inputCanonical.path,
        outputPath: targetCanonical.path,
        partialOutputPath: targetCanonical.path,
        backupPath: null,
        sourceDigest: source.digest,
        outputDigest: readback?.digest ?? null,
        errors: readbackErrors,
        added: zeroAddedCounts(),
      };
    }

    if (options.hooks && typeof options.hooks.afterCopyReadback === 'function') {
      await options.hooks.afterCopyReadback({
        inputPath: inputCanonical.path,
        outputPath: targetCanonical.path,
      });
    }

    await assertStateLocks(locks, { io });
    const sourceAfter = await readStateFile(inputCanonical.path, { io, maxStateBytes });
    if (sourceAfter.digest !== source.digest) {
      return {
        ok: false,
        outcome: 'source_changed',
        commitStatus: 'unknown',
        exitCode: 1,
        inputPath: inputCanonical.path,
        outputPath: targetCanonical.path,
        backupPath: null,
        sourceDigest: source.digest,
        currentSourceDigest: sourceAfter.digest,
        outputDigest: nextDigest,
        outputStatus: 'verified_but_source_changed',
        errors: [
          'The source changed while the copy was being written. The output is internally valid but was derived from the previous bytes; do not treat it as the current fact source.',
        ],
        added: zeroAddedCounts(),
      };
    }

    return {
      ok: true,
      outcome: 'migrated',
      commitStatus: 'verified',
      exitCode: 0,
      inputPath: inputCanonical.path,
      outputPath: targetCanonical.path,
      backupPath: null,
      sourceDigest: source.digest,
      outputDigest: nextDigest,
      report: migration.report,
      warnings: migration.report.warnings,
      errors: [],
      added: runtimeAddedCounts(migration.report),
    };
  } catch (error) {
    return failureResult(error, { inputPath: inputCanonical.path, outputPath: targetCanonical.path });
  } finally {
    await releaseStateLocks(locks, { io });
  }
}

/**
 * @param {object} result
 * @returns {string}
 */
export function formatMigrationResult(result) {
  const lines = [];
  lines.push(
    `${result.ok ? 'OK' : 'FAILED'} ${result.outcome} (commitStatus=${result.commitStatus})`,
  );
  if (result.inputPath) lines.push(`input: ${result.inputPath}`);
  if (result.outputPath) lines.push(`output: ${result.outputPath}`);
  if (result.backupPath) lines.push(`backup: ${result.backupPath}`);
  if (result.temporaryPath) lines.push(`temporary output (pending/failed): ${result.temporaryPath}`);
  if (result.partialOutputPath) lines.push(`partial output (not a valid state): ${result.partialOutputPath}`);
  if (result.sourceDigest) lines.push(`source digest: ${result.sourceDigest}`);
  if (result.outputDigest) lines.push(`output digest: ${result.outputDigest}`);
  if (result.report?.toSchemaVersion) {
    lines.push(
      `stateVersion: ${result.report.fromStateVersion} -> ${result.report.toStateVersion} (${result.report.fromSchemaVersion} -> ${result.report.toSchemaVersion})`,
    );
    lines.push(`generated candidate claims: ${result.report.generatedCandidateClaimIds?.length ?? 0}`);
    lines.push(
      `legacy confirmed decisions awaiting alignment: ${result.report.legacyConfirmedDecisionIds?.length ?? 0}`,
    );
    lines.push(`legacy retired nodes: ${result.report.legacyRetiredNodeIds?.length ?? 0}`);
    lines.push(
      `unclassified material nodes: ${result.report.unclassifiedMaterialNodeIds?.length ?? 0}`,
    );
    if (result.report.legacyConfirmedDecisionIds?.length) {
      lines.push(`legacy confirmed decision IDs: ${result.report.legacyConfirmedDecisionIds.join(', ')}`);
    }
    if (result.report.legacyRetiredNodeIds?.length) {
      lines.push(`legacy retired node IDs: ${result.report.legacyRetiredNodeIds.join(', ')}`);
    }
    if (result.report.unclassifiedMaterialNodeIds?.length) {
      lines.push(
        `unclassified material node IDs: ${result.report.unclassifiedMaterialNodeIds.join(', ')}`,
      );
    }
  }
  lines.push(
    `added this run: confirmed claims ${result.added?.confirmedClaims ?? 0}, decisions ${result.added?.decisions ?? 0}, test executions ${result.added?.testExecutions ?? 0}, runtime observations ${result.added?.runtimeObservations ?? 0}`,
  );
  if (result.message) lines.push(result.message);
  for (const warning of result.warnings ?? []) lines.push(`warning: ${warning}`);
  for (const error of result.errors ?? []) lines.push(`error: ${error}`);
  if (result.details && Object.keys(result.details).length > 0) {
    lines.push(`details: ${JSON.stringify(result.details)}`);
  }
  return lines.join('\n');
}

async function main() {
  const result = await runMigrationCli(process.argv.slice(2));
  const output = formatMigrationResult(result);
  if (result.ok) {
    console.log(output);
  } else {
    console.error(output);
  }
  if (result.exitCode) process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
