#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveNodeIntentSummary, getIntentContent } from './intent-model.mjs';
import { validateStateReferences } from './validate-state.mjs';

const findingLabels = {
  no_supported_behavior_change: 'No supported behavior change',
  consistent_with_confirmed_intent: 'Consistent with confirmed intent',
  potential_mismatch: 'Potential mismatch with confirmed intent',
  proposed_evolution: 'Proposed product evolution',
  existing_discrepancy: 'Existing discrepancy',
  insufficient_evidence: 'Insufficient evidence',
};

function inline(value) {
  return String(value ?? 'Not recorded')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_{}\[\]()<>!]/g, '\\$&')
    .replaceAll('|', '\\|');
}

export function renderCheck(state, check) {
  if (state?.schemaVersion === '0.2') return renderCheck02(state, check);
  const evidenceById = new Map(state.evidence.map((item) => [item.id, item]));
  const nodesById = new Map(state.nodes.map((item) => [item.id, item]));
  const decisionsById = new Map(state.decisions.map((item) => [item.id, item]));
  const lines = [
    `# Change Check: ${inline(check.id)}`,
    '',
    `- **Project:** ${inline(state.project.name)} (${inline(state.project.id)})`,
    `- **Created:** ${inline(check.createdAt)}`,
    `- **Baseline:** ${inline(check.baselineId ?? state.activeBaselineId)}`,
    `- **Base → head:** ${inline(check.base.commit ?? check.base.label)} → ${inline(check.head.commit ?? check.head.label)}`,
    `- **Task intent:** ${inline(check.taskIntent.status)}${check.taskIntent.statement ? ` — ${inline(check.taskIntent.statement)}` : ''}`,
    `- **Scope:** ${inline(check.scope.description)}`,
    `- **Coverage:** ${inline(check.scope.coverageNote)}`,
    '',
    '## Findings',
    '',
  ];

  if (!check.findings.length) lines.push('No findings recorded. This does not mean uninspected areas were verified.');
  for (const finding of check.findings) {
    lines.push(`### ${inline(findingLabels[finding.status] ?? finding.status)}: ${inline(finding.id)}`);
    lines.push('');
    lines.push(inline(finding.summary));
    if (finding.nextAction) {
      lines.push('');
      lines.push(`**Next action:** ${inline(finding.nextAction)}`);
    }

    const nodes = (finding.affectedNodeIds ?? []).map((id) => nodesById.get(id)).filter(Boolean);
    if (nodes.length) {
      lines.push('');
      lines.push('**Affected map items:**');
      for (const node of nodes) lines.push(`- ${inline(node.label)} (\`${inline(node.id)}\`)`);
    }

    const decisions = (finding.decisionIds ?? []).map((id) => decisionsById.get(id)).filter(Boolean);
    if (decisions.length) {
      lines.push('');
      lines.push('**Related decisions:**');
      for (const decision of decisions) lines.push(`- ${inline(decision.statement)} (${inline(decision.status)}; ${inline(decision.applicability)})`);
    }

    const evidence = (finding.evidenceIds ?? []).map((id) => evidenceById.get(id)).filter(Boolean);
    if (evidence.length) {
      lines.push('');
      lines.push('**Evidence:**');
      for (const item of evidence) {
        const location = [item.revision, item.path, item.locator].filter(Boolean).map(inline).join(' · ');
        lines.push(`- ${inline(item.claim)}${location ? ` (${location})` : ''} — ${inline(item.validation)}`);
      }
    }
    lines.push('');
  }

  lines.push('## Review limits', '');
  lines.push(`- Included: ${(check.scope.includedPaths ?? []).map(inline).join(', ') || 'none recorded'}`);
  lines.push(`- Excluded: ${(check.scope.excludedPaths ?? []).map(inline).join(', ') || 'none recorded'}`);
  lines.push(`- ${inline(check.scope.coverageNote)}`);
  lines.push('', '> This receipt summarizes saved evidence. It is not a merge approval or a claim about live user behavior unless runtime observations are explicitly linked.');
  return `${lines.join('\n')}\n`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function currentIntentText(summary) {
  if (!summary.intentCapable) return 'not applicable';
  if (summary.y === 0) return `no active claims (${summary.reason})`;
  return `${summary.x}/${summary.y} confirmed (${summary.reason})`;
}

function intentMarkdownLines(content, indent = '') {
  let value;
  try {
    value = getIntentContent(content);
  } catch {
    value = { statement: 'Not recorded', scope: [], conditions: [], exceptions: [] };
  }
  const lines = [`${indent}- **Statement:** ${inline(value.statement)}`];
  for (const [label, items] of [['Scope', value.scope], ['Conditions', value.conditions], ['Exceptions', value.exceptions]]) {
    lines.push(`${indent}- **${label}:**`);
    if (items.length === 0) {
      lines.push(`${indent}  - Not recorded`);
    } else {
      for (const item of items) lines.push(`${indent}  - ${inline(item)}`);
    }
  }
  if (value.conditions.length === 0 || value.exceptions.length === 0) {
    lines.push(`${indent}- Not recorded does not mean unconditionally applicable.`);
  }
  return lines;
}

function decisionMarkdownLines(decision, indent = '') {
  const lines = [];
  if (decision.recordVersion === '0.2') {
    const kind = decision.kind === 'stop_intent' ? 'Stop intent' : 'Adopt intent';
    lines.push(`${indent}- **${kind}** \`${inline(decision.id)}\` — ${inline(decision.status)}`);
    lines.push(...intentMarkdownLines(decision.intent, `${indent}  `));
    lines.push(`${indent}  - **Applicability:** ${inline(decision.applicability)}`);
    lines.push(`${indent}  - **Review:** \`${inline(decision.reviewId)}\``);
    if (decision.supersedesDecisionIds?.length) {
      lines.push(`${indent}  - **Supersedes:** ${decision.supersedesDecisionIds.map((id) => `\`${inline(id)}\``).join(', ')}`);
    }
    return lines;
  }
  lines.push(`${indent}- **0.1 legacy decision** \`${inline(decision.id)}\` — ${inline(decision.status)}`);
  lines.push(`${indent}  - **Statement:** ${inline(decision.statement)}`);
  lines.push(`${indent}  - **Applicability:** ${inline(decision.applicability)}`);
  if (decision.status === 'confirmed') {
    lines.push(`${indent}  - 0.1 confirmed; not yet aligned to current intent.`);
  }
  return lines;
}

function legacyDecisionLines(decision, indent = '', evidenceById = new Map()) {
  const lines = [];
  lines.push(`${indent}#### Legacy decision \`${inline(decision.id)}\``);
  lines.push('');
  lines.push(`${indent}- **Statement:** ${inline(decision.statement)}`);
  lines.push(`${indent}- **Status:** ${inline(decision.status)} (recordVersion ${inline(decision.recordVersion ?? '0.1')})`);
  lines.push(`${indent}- **Applicability:** ${inline(decision.applicability)}`);
  if (decision.confirmedAt) lines.push(`${indent}- **Confirmed:** ${inline(decision.confirmedAt)} by ${inline(decision.confirmedBy)}`);
  if (decision.evidenceIds?.length) {
    lines.push(`${indent}- **Source evidence:**`);
    for (const evidenceId of decision.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      lines.push(`${indent}  - \`${inline(evidenceId)}\`${evidence ? ` — ${inline(evidence.claim)}` : ''}`);
    }
  }
  if (decision.status === 'confirmed') {
    lines.push(`${indent}- **0.1 confirmed; not yet aligned to current intent.**`);
  }
  lines.push('');
  return lines;
}

/**
 * 0.2 receipt: claims, x/y, history and unresolved 0.1 decisions are shown
 * without promoting a node title or a legacy confirmation into a current claim.
 */
export function renderCheck02(state, check) {
  const evidenceById = new Map(asArray(state.evidence).map((item) => [item.id, item]));
  const nodesById = new Map(asArray(state.nodes).map((item) => [item.id, item]));
  const decisionsById = new Map(asArray(state.decisions).map((item) => [item.id, item]));
  const claims = asArray(state.intentClaims);
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const lines = [
    `# Change Check: ${inline(check.id)}`,
    '',
    `- **Project:** ${inline(state.project.name)} (${inline(state.project.id)})`,
    `- **Created:** ${inline(check.createdAt)}`,
    `- **Baseline:** ${inline(check.baselineId ?? state.activeBaselineId)}`,
    `- **Base → head:** ${inline(check.base.commit ?? check.base.label)} → ${inline(check.head.commit ?? check.head.label)}`,
    `- **Task intent:** ${inline(check.taskIntent.status)}${check.taskIntent.statement ? ` — ${inline(check.taskIntent.statement)}` : ''}`,
    `- **Scope:** ${inline(check.scope.description)}`,
    `- **Coverage:** ${inline(check.scope.coverageNote)}`,
    `- **Schema:** 0.2`,
    '',
    '## Recorded intent for affected nodes',
    '',
  ];

  const affectedNodeIds = [...new Set(check.findings.flatMap((finding) => asArray(finding.affectedNodeIds)))];
  if (affectedNodeIds.length === 0) {
    lines.push('No affected nodes recorded. This does not mean unimplemented behavior was verified.');
    lines.push('');
  }
  for (const nodeId of affectedNodeIds) {
    const node = nodesById.get(nodeId);
    if (!node) {
      lines.push(`### ${inline(nodeId)}`);
      lines.push('');
      lines.push('Affected node reference does not resolve.');
      lines.push('');
      continue;
    }
    const summary = deriveNodeIntentSummary(node, claims);
    const nodeClaims = claims.filter((claim) => claim.nodeId === node.id);
    lines.push(`### ${inline(node.label)} (\`${inline(node.id)}\`)`);
    lines.push('');
    lines.push(`- **Node status:** ${inline(node.status)}`);
    lines.push(`- **Current intent:** ${inline(currentIntentText(summary))}`);
    if (summary.intentCapable) {
      lines.push(`- **History:** superseded ${summary.counts.superseded}, retired ${summary.counts.retired}, dismissed ${summary.counts.dismissed}`);
    }
    if (node.conditions?.length) {
      lines.push('- **Unclassified material:** node-level conditions are historical notes, not intent conditions.');
      for (const condition of node.conditions) lines.push(`  - ${inline(condition)}`);
    }
    lines.push('');
    if (nodeClaims.length === 0) {
      lines.push('No intent claims recorded for this node.');
      lines.push('');
    }
    for (const claim of nodeClaims) {
      lines.push(`#### Claim \`${inline(claim.id)}\` — ${inline(claim.status)}`);
      lines.push('');
      lines.push(...intentMarkdownLines(claim));
      lines.push(`- **Origin:** ${inline(claim.origin)}; **Preparation:** ${inline(claim.assessment?.disposition ?? 'not recorded')}`);
      if (claim.governingDecisionId) lines.push(`- **Governing decision:** \`${inline(claim.governingDecisionId)}\``);
      if (claim.retiredByDecisionId) lines.push(`- **Stop decision:** \`${inline(claim.retiredByDecisionId)}\``);
      if (claim.supersedesClaimIds?.length) lines.push(`- **Supersedes:** ${claim.supersedesClaimIds.map((id) => `\`${inline(id)}\``).join(', ')}`);
      if (claim.supersededByClaimIds?.length) lines.push(`- **Superseded by:** ${claim.supersededByClaimIds.map((id) => `\`${inline(id)}\``).join(', ')}`);
      lines.push('');
    }
    const legacyDecisionId = node.legacy?.snapshot?.decisionId;
    const legacyDecision = legacyDecisionId ? decisionsById.get(legacyDecisionId) : undefined;
    if (legacyDecision) {
      lines.push(...legacyDecisionLines(legacyDecision, '', evidenceById));
    }
  }

  lines.push('## Findings', '');
  if (!check.findings.length) lines.push('No findings recorded. This does not mean uninspected areas were verified.');
  for (const finding of check.findings) {
    lines.push(`### ${inline(findingLabels[finding.status] ?? finding.status)}: ${inline(finding.id)}`);
    lines.push('');
    lines.push(inline(finding.summary));
    if (finding.nextAction) {
      lines.push('');
      lines.push(`**Next action:** ${inline(finding.nextAction)}`);
    }

    const nodes = asArray(finding.affectedNodeIds).map((id) => nodesById.get(id)).filter(Boolean);
    if (nodes.length) {
      lines.push('');
      lines.push('**Affected map items:**');
      for (const node of nodes) {
        const summary = deriveNodeIntentSummary(node, claims);
        lines.push(`- ${inline(node.label)} (\`${inline(node.id)}\`) — ${inline(node.status)}, current intent ${inline(currentIntentText(summary))}`);
      }
    }

    const decisions = asArray(finding.decisionIds).map((id) => decisionsById.get(id)).filter(Boolean);
    if (decisions.length) {
      lines.push('');
      lines.push('**Related decisions:**');
      for (const decision of decisions) lines.push(...decisionMarkdownLines(decision));
    }

    const evidence = asArray(finding.evidenceIds).map((id) => evidenceById.get(id)).filter(Boolean);
    if (evidence.length) {
      lines.push('');
      lines.push('**Evidence:**');
      for (const item of evidence) {
        const location = [item.revision, item.path, item.locator].filter(Boolean).map(inline).join(' · ');
        lines.push(`- ${inline(item.claim)}${location ? ` (${location})` : ''} — ${inline(item.validation)}`);
      }
    }
    lines.push('');
  }

  lines.push('## Review limits', '');
  lines.push(`- Included: ${(check.scope.includedPaths ?? []).map(inline).join(', ') || 'none recorded'}`);
  lines.push(`- Excluded: ${(check.scope.excludedPaths ?? []).map(inline).join(', ') || 'none recorded'}`);
  lines.push(`- ${inline(check.scope.coverageNote)}`);
  lines.push('', '> This receipt summarizes saved evidence and recorded intent. It is not a merge approval or a claim about live user behavior unless runtime observations are explicitly linked.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const forceIndex = args.indexOf('--force');
  const force = forceIndex >= 0;
  if (force) args.splice(forceIndex, 1);
  const [statePath, checkId, outputPath] = args;
  if (!statePath || !checkId || args.length > 3) {
    console.error('Usage: node scripts/render-check.mjs <project-state.json> <check-id> [output.md] [--force]');
    process.exitCode = 2;
    return;
  }

  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    console.error(`Cannot read state JSON: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (state?.schemaVersion !== '0.1' && state?.schemaVersion !== '0.2') {
    console.error(`Unsupported or missing schemaVersion: ${String(state?.schemaVersion)}`);
    process.exitCode = 2;
    return;
  }
  const referenceErrors = validateStateReferences(state);
  if (referenceErrors.length) {
    console.error(referenceErrors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
    return;
  }

  const check = state.checks.find((item) => item.id === checkId);
  if (!check) {
    console.error(`No change check found with id "${checkId}".`);
    process.exitCode = 1;
    return;
  }
  const output = resolve(outputPath ?? resolve(dirname(resolve(statePath)), 'checks', `${checkId.replace(/[^a-zA-Z0-9._-]/g, '_')}.md`));
  try {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, renderCheck(state, check), force ? 'utf8' : { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    console.error(`Cannot write ${output}: ${error.message}${error.code === 'EEXIST' ? ' (choose another path or pass --force to replace it)' : ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Change receipt written to ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
