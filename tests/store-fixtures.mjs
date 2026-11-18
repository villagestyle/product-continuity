import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digestValue } from '../scripts/intent-model.mjs';
import { commandDigest, normalizeCommand } from '../scripts/review-actions.mjs';

const TEMP_ROOT =
  process.env.PRODUCT_CONTINUITY_TEST_TMP ??
  path.join('C:\\Users\\Administrator\\AppData\\Local\\Temp', 'opencode');

/**
 * A minimal valid 0.2 state with one candidate onboarding claim and no reviews.
 * The claim is intentionally unreviewed so integration tests must go through a
 * real edit_candidate preparation before they can confirm it.
 */
export function makeStoreState() {
  const content = {
    statement: 'Users can browse the demo catalog.',
    scope: [],
    conditions: [],
    exceptions: [],
  };
  return {
    schemaVersion: '0.2',
    stateVersion: 1,
    project: {
      id: 'project:store-test',
      name: 'Store Test',
      roots: ['.'],
      scopeDescription: 'Synthetic state used only by temporary store tests',
    },
    activeBaselineId: 'baseline:store',
    baselines: [
      {
        id: 'baseline:store',
        revision: { worktree: 'unknown', label: 'Synthetic store test' },
        scope: {
          description: 'Synthetic',
          includedPaths: [],
          excludedPaths: [],
          coverageNote: 'No source inspected',
        },
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    nodes: [
      {
        id: 'goal:demo',
        kind: 'product_goal',
        label: 'Demo goal',
        description: 'Synthetic goal for storage tests.',
        status: 'candidate',
        evidenceIds: [],
      },
    ],
    edges: [],
    evidence: [],
    decisions: [],
    intentClaims: [
      {
        id: 'claim:demo:v1',
        nodeId: 'goal:demo',
        ...content,
        status: 'candidate',
        origin: 'onboarding',
        createdAt: '2026-01-01T00:00:00.000Z',
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
      },
    ],
    proposals: [],
    reviews: [],
    checks: [],
  };
}

export async function makeTempDir(prefix = 'pc-store-') {
  const roots = [TEMP_ROOT, os.tmpdir()];
  let lastError;
  for (const root of roots) {
    try {
      return await mkdtemp(path.join(root, prefix));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function writeStateFile(directory, state, name = 'project-state.json') {
  const statePath = path.join(directory, name);
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await writeFile(statePath, bytes);
  return {
    statePath,
    bytes,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/**
 * Fake review domain for storage tests. Its action result is deliberately
 * minimal (a defer review) but the command and payloadDigest use the real
 * review-action contract, so the shared state invariants still apply.
 */
export function makeFakeDomain(options = {}) {
  let sequence = 0;
  const makeReview = (state, request, fileDigest) => {
    const command = normalizeCommand(request);
    const review = {
      id: `review:fake-${++sequence}`,
      createdAt: new Date('2026-01-02T00:00:00.000Z').toISOString(),
      actor: 'local-user',
      source: 'local_review_ui',
      command,
      observedStateVersion: state.stateVersion,
      observedDigest: fileDigest,
      idempotencyKey: request.idempotencyKey,
      payloadDigest: commandDigest(request),
      createdClaimIds: [],
      affectedClaimIds: [request.targetClaimId].filter(Boolean),
      resultingStateVersion: state.stateVersion + 1,
    };
    return review;
  };

  const domain = {
    commandDigest(request) {
      return commandDigest(request);
    },
    normalizeCommand,
    async previewReview(state, request, { fileDigest }) {
      if (options.previewGate) await options.previewGate;
      if (request.expectedStateVersion !== state.stateVersion) {
        const error = new Error('stale state');
        error.code = 'stale_state';
        error.status = 409;
        error.commitStatus = 'not_committed';
        throw error;
      }
      const plan = {
        action: request.action,
        targetClaimId: request.targetClaimId ?? null,
        targetProposalId: request.targetProposalId ?? null,
        fileDigest,
      };
      return {
        previewDigest: digestValue(plan),
        plan,
        action: request.action,
        requiresPreview: false,
        attestations: [],
      };
    },
    async applyReview(state, request, { fileDigest }) {
      if (options.applyGate) await options.applyGate;
      if (options.applyError) throw options.applyError;
      if (request.projectId !== state.project.id) {
        const error = new Error('project mismatch');
        error.code = 'target_not_found';
        error.status = 404;
        error.commitStatus = 'not_committed';
        throw error;
      }
      if (request.expectedStateVersion !== state.stateVersion) {
        const error = new Error('stale state');
        error.code = 'stale_state';
        error.status = 409;
        error.commitStatus = 'not_committed';
        throw error;
      }
      if (request.expectedDigest !== fileDigest) {
        const error = new Error('stale digest');
        error.code = 'stale_state';
        error.status = 409;
        error.commitStatus = 'not_committed';
        throw error;
      }
      const review = makeReview(state, request, fileDigest);
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          reviews: [...state.reviews, review],
        },
        review,
        command: review.command,
        createdClaimIds: [],
        affectedClaimIds: review.affectedClaimIds,
      };
    },
  };
  if (options.validateTransition) domain.validateTransition = options.validateTransition;
  return domain;
}

export function deferRequest({ projectId, stateVersion, digest, idempotencyKey, note = 'Store test' }) {
  return {
    projectId,
    action: 'defer',
    targetClaimId: 'claim:demo:v1',
    payload: note ? { reason: 'other', note } : { reason: 'needs_decision' },
    expectedStateVersion: stateVersion,
    expectedDigest: digest,
    idempotencyKey,
  };
}

export function previewDeferRequest({ projectId, stateVersion, digest }) {
  return {
    projectId,
    action: 'defer',
    targetClaimId: 'claim:demo:v1',
    payload: { reason: 'needs_decision' },
    expectedStateVersion: stateVersion,
    expectedDigest: digest,
  };
}

export function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
