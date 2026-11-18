// Bounded, read-only inspection of this state file's completed backups only.
// No repository scan, watcher, state replay, restoration or new persistence.
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalStringify } from './intent-model.mjs';
import { sha256Bytes, validateFullState } from './state-store.mjs';
import { deriveProgress } from './timeline-model.mjs';

export async function readTimelineHistory(statePath, snapshot, options = {}) {
  return (await inspectHistory(statePath, snapshot, options)).history;
}

// A selector is an exact version/digest pair, never a client-supplied file path.
// Reuse the entire bounded validation path on each read; no stale path cache.
export async function readTimelineSnapshot(statePath, snapshot, selector, options = {}) {
  if (!Number.isSafeInteger(selector?.stateVersion) || selector.stateVersion < 1 || !/^sha256:[0-9a-f]{64}$/.test(selector.digest || '')) return null;
  return (await inspectHistory(statePath, snapshot, options, selector)).selected;
}

async function inspectHistory(statePath, snapshot, options, selector = null) {
  options.signal?.throwIfAborted();
  const state = snapshot.state;
  const now = options.now ?? new Date().toISOString();
  const maxFileBytes = options.maxStateBytes ?? 10 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 32 * 1024 * 1024;
  const maxBackups = options.maxBackups ?? 64;
  const maxEntries = options.maxEntries ?? 4096;
  const warnings = new Set();
  const samples = [];
  let selected = null;
  const reviews = Array.isArray(state?.reviews) ? state.reviews : [];
  const updates = Array.isArray(state?.mapUpdates) ? state.mapUpdates : [];
  const captures = Array.isArray(state?.conversationCaptures) ? state.conversationCaptures : [];
  const transitions = [...reviews, ...updates, ...captures];
  const versionTime = (value) => {
    const record = [...(value.reviews || []), ...(value.mapUpdates || []), ...(value.conversationCaptures || [])].find((item) => item.resultingStateVersion === value.stateVersion);
    const basis = record?.source === 'opencode_conversation' ? 'conversation' : record?.source === 'local_map_maintenance' ? 'maintenance' : record?.source === 'local_roadmap_planning' ? 'planning' : record?.source === 'local_feature_checkpoint' ? 'checkpoint' : 'review';
    return record?.createdAt && Number.isFinite(Date.parse(record.createdAt)) ? {at:new Date(record.createdAt).toISOString(), basis} : null;
  };
  const statesByDigest = new Map();
  const add = (value, digest, source) => {
    const time = versionTime(value);
    const sample = { stateVersion:value.stateVersion, digest, source, at:time?.at || (source === 'current' ? now : null), timeBasis:time?.basis || (source === 'current' ? 'read' : 'unknown'), metrics:deriveProgress(value) };
    statesByDigest.set(digest, value);
    samples.push(sample);
    if (selector?.stateVersion === value.stateVersion && selector.digest === digest) selected = { state:value, sample };
  };
  const basename = path.basename(statePath);
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\.bak\\.(\\d+)\\.([0-9a-f]{8})\\.([0-9a-f]{8})$`);
  const candidates = [];
  let directory;
  try {
    directory = await fs.opendir(path.dirname(statePath));
    let count = 0;
    for await (const entry of directory) {
      if (++count > maxEntries) { warnings.add('entry_limit'); break; }
      const match = pattern.exec(entry.name);
      if (match) candidates.push({name:entry.name, version:Number(match[1]), prefix:match[2]});
    }
  } catch { warnings.add('history_unavailable'); }
  candidates.sort((a, b) => b.version - a.version || a.name.localeCompare(b.name));
  if (candidates.length > maxBackups) warnings.add('backup_limit');
  let bytesRead = 0, accepted = 0, rejected = 0;
  const seen = new Set();
  for (const candidate of candidates.slice(0, maxBackups)) {
    options.signal?.throwIfAborted();
    // Every sample must be anchored by a retained review/maintenance exact observed
    // digest/version, not a filename, mtime, same project name or guessed replay.
    const anchor = transitions.find((record) => record.observedStateVersion === candidate.version && record.observedDigest?.slice(7, 15) === candidate.prefix);
    if (!anchor || candidate.version >= state.stateVersion) { rejected++; warnings.add('unanchored_backup'); continue; }
    let handle;
    try {
      const filename = path.join(path.dirname(statePath), candidate.name);
      const before = await fs.lstat(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxFileBytes) throw new Error('unsafe backup');
      if (bytesRead + before.size > maxTotalBytes) { warnings.add('byte_limit'); break; }
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('changed backup');
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        options.signal?.throwIfAborted();
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      bytesRead += length;
      if (length !== before.size) throw new Error('changed size');
      const after = await fs.lstat(filename);
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('changed path');
      const bytes = buffer.subarray(0, length), digest = sha256Bytes(bytes);
      if (digest !== anchor.observedDigest) throw new Error('digest mismatch');
      const old = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
      if (old.schemaVersion !== '0.2' || old.project?.id !== state.project?.id || old.stateVersion !== candidate.version || validateFullState(old).length) throw new Error('invalid backup');
      const prefix = reviews.filter((review) => review.resultingStateVersion <= old.stateVersion);
      if (canonicalStringify(prefix) !== canonicalStringify(old.reviews)) throw new Error('unrelated history');
      const updatePrefix = updates.filter((record) => record.resultingStateVersion <= old.stateVersion);
      if (canonicalStringify(updatePrefix) !== canonicalStringify(old.mapUpdates || [])) throw new Error('unrelated maintenance history');
      const capturePrefix = captures.filter((record) => record.resultingStateVersion <= old.stateVersion);
      if (canonicalStringify(capturePrefix) !== canonicalStringify(old.conversationCaptures || [])) throw new Error('unrelated conversation history');
      if (!seen.has(digest)) { add(old, digest, 'backup'); seen.add(digest); accepted++; }
    } catch { rejected++; warnings.add('invalid_backup'); }
    finally { if (handle) await handle.close().catch(() => {}); }
  }
  if (state?.schemaVersion === '0.2') add(state, snapshot.fileDigest ?? snapshot.currentDigest ?? '', 'current');
  samples.sort((a, b) => a.stateVersion - b.stateVersion);
  // A complete snapshot is trusted only if its roadmap items are explained by
  // planning receipts in the exact version interval. For a direct one-step
  // transition, the changed IDs must match the receipt exactly (not merely
  // include it), so a forged backup cannot hide or invent an item change.
  const roadmapMap = (value) => new Map(
    (Array.isArray(value?.roadmapItems) ? value.roadmapItems : [])
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => [item.id, canonicalStringify(item)]),
  );
  const changedRoadmapIds = (beforeState, afterState) => {
    const before = roadmapMap(beforeState), after = roadmapMap(afterState);
    return [...new Set([...before.keys(), ...after.keys()])].filter((id) => before.get(id) !== after.get(id));
  };
  const dropped = new Set();
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1], sample = samples[index];
    const previousState = statesByDigest.get(previous.digest), sampleState = statesByDigest.get(sample.digest);
    if (previousState && sampleState) {
      const changed = changedRoadmapIds(previousState, sampleState);
      const beforeItems = new Map((previousState.roadmapItems ?? []).map((item) => [item.id,item]));
      const afterItems = new Map((sampleState.roadmapItems ?? []).map((item) => [item.id,item]));
      const brokenIdentity = [...beforeItems].some(([id,item]) => !afterItems.has(id) || afterItems.get(id).nodeId !== item.nodeId);
      const between = updates.filter((update) => update.source === 'local_roadmap_planning' && update.resultingStateVersion > previous.stateVersion && update.resultingStateVersion <= sample.stateVersion);
      const planned = new Set(between.flatMap((update) => Array.isArray(update.changedRoadmapItemIds) ? update.changedRoadmapItemIds : []));
      const direct = between.length === 1 && between[0].observedStateVersion === previous.stateVersion && between[0].resultingStateVersion === sample.stateVersion;
      const unexplained = changed.filter((id) => !planned.has(id));
      const invented = direct ? [...planned].filter((id) => !changed.includes(id)) : [];
      if (unexplained.length || invented.length || brokenIdentity) {
        // A pair cannot tell which endpoint was externally rewritten. Exclude
        // both historical endpoints rather than blaming only the newer one and
        // accidentally trusting a forged earliest backup. Current stays current
        // with a warning; this reader never rolls it back or repairs history.
        for (const endpoint of [previous,sample]) if (endpoint.source === 'backup') dropped.add(endpoint.digest);
        warnings.add('unexplained_roadmap_change');
      }
    }
  }
  // Checkpoints are append-only. A retained snapshot must contain the exact
  // earlier checkpoint array as a prefix, and every newly visible checkpoint
  // must be explained by a local_feature_checkpoint receipt in the version
  // interval. A single direct receipt must match the added ids exactly.
  const checkpointList = (value) => Array.isArray(value?.featureCheckpoints) ? value.featureCheckpoints : [];
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1], sample = samples[index];
    const previousState = statesByDigest.get(previous.digest), sampleState = statesByDigest.get(sample.digest);
    if (!previousState || !sampleState) continue;
    const before = checkpointList(previousState), after = checkpointList(sampleState);
    let prefixIntact = after.length >= before.length;
    for (let item = 0; prefixIntact && item < before.length; item++) {
      if (canonicalStringify(before[item]) !== canonicalStringify(after[item])) prefixIntact = false;
    }
    if (!prefixIntact) {
      for (const endpoint of [previous, sample]) if (endpoint.source === 'backup') dropped.add(endpoint.digest);
      warnings.add('unexplained_checkpoint_change');
      continue;
    }
    const added = after.slice(before.length).map((record) => record?.id).filter((id) => typeof id === 'string');
    if (added.length === 0) continue;
    const between = updates.filter((update) => update.source === 'local_feature_checkpoint' && update.resultingStateVersion > previous.stateVersion && update.resultingStateVersion <= sample.stateVersion);
    const explained = new Set(between.flatMap((update) => Array.isArray(update.addedFeatureCheckpointIds) ? update.addedFeatureCheckpointIds : []));
    const direct = between.length === 1 && between[0].observedStateVersion === previous.stateVersion && between[0].resultingStateVersion === sample.stateVersion;
    const unexplained = added.filter((id) => !explained.has(id));
    const invented = direct ? [...explained].filter((id) => !added.includes(id)) : [];
    if (unexplained.length || invented.length) {
      for (const endpoint of [previous, sample]) if (endpoint.source === 'backup') dropped.add(endpoint.digest);
      warnings.add('unexplained_checkpoint_change');
    }
  }
  if (dropped.size) { rejected += dropped.size; accepted -= dropped.size; warnings.add('invalid_backup'); }
  const trusted = samples.filter((sample) => !dropped.has(sample.digest));
  samples.length = 0;
  samples.push(...trusted);
  if (selected && dropped.has(selected.sample.digest)) selected = null;
  for (let index = 0; index < samples.length; index++) samples[index].gapBefore = index > 0 && samples[index].stateVersion !== samples[index - 1].stateVersion + 1;
  if (samples.some((sample) => sample.gapBefore)) warnings.add('version_gap');
  if (samples.some((sample) => sample.timeBasis === 'unknown')) warnings.add('unknown_snapshot_time');
  const timedSamples = samples.filter((sample) => ['review','maintenance','planning','checkpoint','conversation'].includes(sample.timeBasis) && sample.at);
  if (timedSamples.some((sample, index) => index > 0 && Date.parse(sample.at) < Date.parse(timedSamples[index - 1].at))) warnings.add('clock_regression');
  return { history:{ samples, warnings:[...warnings], acceptedBackups:accepted, rejectedBackups:rejected, checkedAt:now }, selected };
}
