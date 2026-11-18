#!/usr/bin/env node
/**
 * Out-of-band, one-time maintenance authorization writer.
 *
 * This is deliberately a CLI, not an MCP tool: the MCP server has no tool that
 * can create a grant. A human is expected to read the preview diff and then run
 * this command (or otherwise write the fixed-format grant file). The CLI cannot
 * prove that a human ran it; it is a cooperative local review bridge. It never
 * edits project state, decisions, reviews, claims or proposals.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { resolveProjectBinding } from './mcp-context.mjs';
import {
  MAINTENANCE_GRANT_FORMAT,
  MAINTENANCE_LIMITS,
  McpMaintenanceError,
  maintenancePlanDigest,
  normaliseMaintenanceArguments,
  previewMaintenance,
  readMaintenanceAuthorizationGrant,
  resolveMaintenanceAuthorizationBinding,
} from './mcp-maintenance.mjs';

const VALUE_ARGUMENTS = Object.freeze({
  '--project-root': 'projectRoot',
  '--state': 'state',
  '--project-id': 'projectId',
  '--authorization': 'authorization',
  '--plan': 'plan',
  '--approved-by': 'approvedBy',
  '--expires-at': 'expiresAt',
  '--approval-source': 'approvalSource',
});
const FLAG_ARGUMENTS = Object.freeze({
  '--replace': 'replace',
  '--yes': 'yes',
});

export function parseAuthorizeArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (Object.hasOwn(FLAG_ARGUMENTS, argument)) {
      const key = FLAG_ARGUMENTS[argument];
      if (Object.hasOwn(values, key)) throw new McpMaintenanceError('invalid_arguments', 'Duplicate startup flag.');
      values[key] = true;
      continue;
    }
    const key = Object.hasOwn(VALUE_ARGUMENTS, argument) ? VALUE_ARGUMENTS[argument] : null;
    const value = args[index + 1];
    if (!key || Object.hasOwn(values, key) || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new McpMaintenanceError('invalid_arguments', 'Invalid or duplicate authorization arguments.');
    }
    values[key] = value;
    index += 1;
  }
  for (const key of ['projectRoot', 'state', 'projectId', 'authorization', 'plan', 'approvedBy', 'expiresAt']) {
    if (!Object.hasOwn(values, key)) {
      throw new McpMaintenanceError(
        'invalid_arguments',
        'Require --project-root, --state, --project-id, --authorization, --plan, --approved-by and --expires-at.',
      );
    }
  }
  values.approvalSource ??= 'host_shell';
  values.replace = values.replace === true;
  values.yes = values.yes === true;
  return values;
}

async function readPlanFile(planPath) {
  let handle;
  try {
    handle = await fsp.open(planPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAINTENANCE_LIMITS.maxPlanBytes) {
      throw new McpMaintenanceError('invalid_arguments', 'The plan file must be a regular file within the MCP plan byte limit.');
    }
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAINTENANCE_LIMITS.maxPlanBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size || length > MAINTENANCE_LIMITS.maxPlanBytes) {
      throw new McpMaintenanceError('invalid_arguments', 'The plan file changed or exceeds the MCP plan byte limit.');
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new McpMaintenanceError('invalid_arguments', 'The plan file is not valid UTF-8.');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new McpMaintenanceError('invalid_arguments', 'The plan file is not valid JSON.');
    }
  } catch (error) {
    if (error instanceof McpMaintenanceError) throw error;
    throw new McpMaintenanceError('invalid_arguments', 'The plan file does not exist or is not accessible.');
  } finally {
    await handle?.close();
  }
}

function approvalSource(value) {
  if (!['host_shell', 'host_cli', 'manual_file'].includes(value)) {
    throw new McpMaintenanceError(
      'invalid_arguments',
      'approvalSource must be host_shell, host_cli or manual_file.',
    );
  }
  return value;
}

function approvedBy(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new McpMaintenanceError('invalid_arguments', 'approvedBy must be a short non-empty label.');
  }
  return value;
}

async function writeGrantFile(target, bytes, { replace }) {
  if (!replace) {
    try {
      await fsp.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new McpMaintenanceError(
          'maintenance_authorization_exists',
          'A grant file already exists at the fixed path. Inspect it; use --replace only for an expired or wrong grant.',
        );
      }
      throw new McpMaintenanceError('maintenance_authorization_write_failed', 'The one-time grant could not be written.');
    }
    return;
  }
  let stat = null;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new McpMaintenanceError('maintenance_authorization_unsafe', 'The existing grant path cannot be inspected safely.');
    }
  }
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) {
    throw new McpMaintenanceError('maintenance_authorization_unsafe', 'The existing grant is not a single-link regular file.');
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.pending`;
  try {
    await fsp.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fsp.rename(temporary, target);
  } catch {
    try {
      await fsp.unlink(temporary);
    } catch {
      // Leave only a clearly named .pending file for inspection.
    }
    throw new McpMaintenanceError('maintenance_authorization_write_failed', 'The one-time grant could not be replaced safely.');
  }
}

function summaryLines(preview) {
  const lines = [
    `State: ${preview.state.relativePath} v${preview.state.stateVersion} ${preview.state.fileDigest}`,
    `Operation: ${preview.plan.operationId}`,
    `Plan digest: ${preview.plan.planDigest}`,
    `Expected base: v${preview.plan.expectedStateVersion} ${preview.plan.expectedDigest}`,
    `Result: ${preview.result.replayed ? 'already recorded; apply would replay without a new version' : `would create v${preview.result.stateVersion}`}`,
    `Diff: +${preview.diff.counts.nodesAdded} nodes, ~${preview.diff.counts.nodesChanged} nodes, +${preview.diff.counts.edgesAdded} edges, +${preview.diff.counts.evidenceAdded} evidence, +${preview.diff.counts.checksAdded} checks`,
  ];
  for (const node of preview.diff.nodes.added) {
    lines.push(`  + node ${node.id} (${node.kind}): ${node.label}`);
  }
  for (const node of preview.diff.nodes.changed) {
    lines.push(`  ~ node ${node.id} (${node.kind}): ${node.fields.map((field) => field.field).join(', ')}`);
  }
  for (const edge of preview.diff.edges.added) {
    lines.push(`  + edge ${edge.id}: ${edge.from} -[${edge.kind}]-> ${edge.to}`);
  }
  for (const evidence of preview.diff.evidence.added) {
    lines.push(`  + evidence ${evidence.id} (${evidence.kind}): ${evidence.claim}`);
  }
  for (const check of preview.diff.checks.added) {
    lines.push(`  + check ${check.id}`);
  }
  lines.push('Protected: decisions, reviews, intent claims, proposals, roadmap items, baselines and project identity are not changed by this plan.');
  return lines;
}

async function main() {
  let args;
  let binding;
  let maintenance;
  let plan;
  try {
    args = parseAuthorizeArguments(process.argv.slice(2));
    binding = await resolveProjectBinding(args);
    maintenance = await resolveMaintenanceAuthorizationBinding(binding, args.authorization);
    const rawPlan = await readPlanFile(args.plan);
    plan = normaliseMaintenanceArguments(rawPlan, binding.projectId);
    const source = approvalSource(args.approvalSource);
    const by = approvedBy(args.approvedBy);
    const preview = await previewMaintenance(binding, maintenance, plan, {
      clock: new Date().toISOString(),
    });

    process.stdout.write(`${summaryLines(preview).join('\n')}\n`);
    process.stdout.write(`${JSON.stringify(preview.diff, null, 2)}\n`);
    process.stdout.write(
      'This grant is a local operational artifact, not a product decision. It does not confirm intent or approve a merge.\n',
    );

    if (!args.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      let answer;
      try {
        answer = await rl.question('Type APPROVE to write this one-time authorization grant: ');
      } finally {
        rl.close();
      }
      if (answer.trim() !== 'APPROVE') {
        process.stderr.write('Not approved. No grant was written.\n');
        process.exitCode = 2;
        return;
      }
    }

    const approvedAt = new Date().toISOString();
    const approvedAtMs = Date.parse(approvedAt);
    const expiresAtMs = Date.parse(args.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new McpMaintenanceError('invalid_arguments', 'expiresAt must be an ISO date-time.');
    }
    if (expiresAtMs <= approvedAtMs) {
      throw new McpMaintenanceError('invalid_arguments', 'expiresAt must be after the approval time.');
    }
    if (expiresAtMs - approvedAtMs > MAINTENANCE_LIMITS.maxGrantTtlMs) {
      throw new McpMaintenanceError(
        'invalid_arguments',
        `The grant lifetime must not exceed ${MAINTENANCE_LIMITS.maxGrantTtlMs / (60 * 60 * 1000)} hours.`,
      );
    }
    const grant = {
      format: MAINTENANCE_GRANT_FORMAT,
      grantId: randomUUID(),
      projectId: plan.projectId,
      operationId: plan.operationId,
      planDigest: maintenancePlanDigest(plan),
      expectedStateVersion: plan.expectedStateVersion,
      expectedDigest: plan.expectedDigest,
      approvalSource: source,
      approvedBy: by,
      approvedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      oneTime: true,
    };
    const bytes = Buffer.from(`${JSON.stringify(grant, null, 2)}\n`, 'utf8');
    await writeGrantFile(maintenance.authorizationPath, bytes, { replace: args.replace });
    // Read back with the same verifier the MCP apply path uses. This does not
    // consume the grant and does not write project state.
    const verified = await readMaintenanceAuthorizationGrant(maintenance, plan, { clock: approvedAt });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      wrote: true,
      authorization: {
        relativePath: maintenance.relativeAuthorizationPath,
        grantId: verified.grant.grantId,
        planDigest: verified.planDigest,
        expectedStateVersion: verified.grant.expectedStateVersion,
        expectedDigest: verified.grant.expectedDigest,
        approvalSource: verified.grant.approvalSource,
        approvedBy: verified.grant.approvedBy,
        approvedAt: verified.grant.approvedAt,
        expiresAt: verified.grant.expiresAt,
        oneTime: true,
        isHumanDecisionRecord: false,
      },
      applied: false,
      note: 'The grant is not a product decision. Run maintenance_apply or the offline CLI separately; this command never writes project state.',
    }, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof McpMaintenanceError ? error.code : (error?.code ?? 'authorization_failed');
    const message = error instanceof McpMaintenanceError
      ? error.message
      : 'The authorization command failed safely.';
    process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
