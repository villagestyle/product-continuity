#!/usr/bin/env node

/**
 * Full JSON Schema validation for the 0.1/0.2 state contract and strict review
 * requests. This module is the only place that needs AJV at runtime; static
 * map/check rendering and reference validation stay dependency-free.
 *
 * AJV is compiled once with draft 2020-12, strict mode, allErrors and no type
 * coercion/default insertion/removal. Validation therefore observes the bytes
 * it was given and never silently repairs a request or a state.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schemaDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

function loadSchema(name) {
  return JSON.parse(readFileSync(resolve(schemaDirectory, name), 'utf8'));
}

export const schemaIds = Object.freeze({
  state: 'urn:product-continuity:project-state',
  state01: 'urn:product-continuity:project-state:0.1',
  state02: 'urn:product-continuity:project-state:0.2',
  reviewCommand: 'urn:product-continuity:review-command',
});

function createAjv() {
  const ajv = new Ajv2020({
    strict: true,
    // The frozen 0.1 schema uses `properties`/`required` inside conditional
    // branches without repeating `type: "object"`. strictTypes/strictRequired
    // flag that authoring style only; they do not change validation semantics.
    // Keep every other strict check and all no-mutation options on.
    strictRequired: false,
    strictTypes: false,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateSchema: true,
    validateFormats: true,
    allowUnionTypes: false,
    strictNumbers: true,
  });
  addFormats(ajv);
  return ajv;
}

function formatErrors(validate) {
  return (validate.errors ?? []).map((error) => {
    const location = error.instancePath || '/';
    return `${location}: ${error.message ?? 'invalid'} [${error.keyword}]`;
  });
}

let compiled;

/**
 * Compile every schema once and return the validators.
 * Callers that need the raw AJV validators can use getCompiledValidators().
 *
 * @returns {{
 *   ajv: import('ajv').default,
 *   state01: Function,
 *   state02: Function,
 *   stateDispatch: Function,
 *   reviewCommand: Function,
 *   reviewRequest: Function,
 *   previewRequest: Function
 * }}
 */
export function getCompiledValidators() {
  if (compiled) return compiled;

  const ajv = createAjv();
  ajv.addSchema(loadSchema('project-state-0.1.schema.json'), schemaIds.state01);
  ajv.addSchema(loadSchema('review-command.schema.json'), schemaIds.reviewCommand);
  ajv.addSchema(loadSchema('project-state-0.2.schema.json'), schemaIds.state02);
  ajv.addSchema(loadSchema('project-state.schema.json'), schemaIds.state);

  const state01 = ajv.getSchema(schemaIds.state01);
  const state02 = ajv.getSchema(schemaIds.state02);
  const stateDispatch = ajv.getSchema(schemaIds.state);
  const reviewCommand = ajv.getSchema(schemaIds.reviewCommand);
  const reviewRequest = ajv.compile({ $ref: `${schemaIds.reviewCommand}#/$defs/reviewRequest` });
  const previewRequest = ajv.compile({ $ref: `${schemaIds.reviewCommand}#/$defs/previewRequest` });

  if (!state01 || !state02 || !stateDispatch || !reviewCommand) {
    throw new Error('Invalid schema registration: state or review validators did not compile');
  }

  compiled = { ajv, state01, state02, stateDispatch, reviewCommand, reviewRequest, previewRequest };
  return compiled;
}

/**
 * Validate a project state against the version-specific strict schema.
 * Returns a list of readable errors; [] means schema-valid. This does not run
 * reference checks or intent invariants; use validateStateReferences() plus
 * validateIntentInvariants() for the full state gate.
 *
 * @param {unknown} state
 * @returns {string[]}
 */
export function validateStateSchema(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return ['/: expected a project state object'];
  }
  const version = state.schemaVersion;
  const validators = getCompiledValidators();
  let validate;
  if (version === '0.1') {
    validate = validators.state01;
  } else if (version === '0.2') {
    validate = validators.state02;
  } else {
    return [`/schemaVersion: unsupported version "${String(version)}"`];
  }
  if (validate(state)) return [];
  return formatErrors(validate);
}

/**
 * Validate through the version-dispatch schema (oneOf 0.1/0.2) without
 * choosing a branch first. Kept public so callers can prove that the entry
 * schema itself rejects unknown versions.
 *
 * @param {unknown} state
 * @returns {string[]}
 */
export function validateStateDispatch(state) {
  const { stateDispatch } = getCompiledValidators();
  if (stateDispatch(state)) return [];
  return formatErrors(stateDispatch);
}

/**
 * Validate a final review submission (all nine actions). Returns [] when the
 * request matches the strict submit branch.
 *
 * @param {unknown} request
 * @returns {string[]}
 */
export function validateReviewRequest(request) {
  const { reviewRequest } = getCompiledValidators();
  if (reviewRequest(request)) return [];
  return formatErrors(reviewRequest);
}

/**
 * Validate a read-only preview request. Preview branches exclude
 * idempotencyKey, previewDigest and final attestations by construction.
 *
 * @param {unknown} request
 * @returns {string[]}
 */
export function validatePreviewRequest(request) {
  const { previewRequest } = getCompiledValidators();
  if (previewRequest(request)) return [];
  return formatErrors(previewRequest);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/validate-schema-runner.mjs <project-state.json> [more...]');
    console.error('       node scripts/validate-schema-runner.mjs --review <request.json>');
    console.error('       node scripts/validate-schema-runner.mjs --preview <request.json>');
    process.exitCode = 2;
    return;
  }

  const requestIndex = args.findIndex((arg) => arg === '--review' || arg === '--preview');
  if (requestIndex >= 0) {
    const mode = args[requestIndex];
    const filename = args[requestIndex + 1];
    if (!filename || args.length !== requestIndex + 2) {
      console.error(`Usage: node scripts/validate-schema-runner.mjs ${mode} <request.json>`);
      process.exitCode = 2;
      return;
    }
    const request = JSON.parse(readFileSync(filename, 'utf8'));
    const errors = mode === '--review' ? validateReviewRequest(request) : validatePreviewRequest(request);
    if (errors.length) {
      console.error(`Invalid ${mode === '--review' ? 'review' : 'preview'} request ${filename}:`);
      console.error(errors.map((error) => `- ${error}`).join('\n'));
      process.exitCode = 1;
      return;
    }
    console.log(`${filename}: ${mode === '--review' ? 'review' : 'preview'} request schema valid`);
    return;
  }

  let failed = false;
  for (const filename of args) {
    let state;
    try {
      state = JSON.parse(readFileSync(filename, 'utf8'));
    } catch (error) {
      console.error(`${filename}: cannot read valid JSON: ${error.message}`);
      failed = true;
      continue;
    }
    const errors = validateStateSchema(state);
    if (errors.length) {
      console.error(`${filename}: schema ${String(state?.schemaVersion)} invalid:`);
      console.error(errors.map((error) => `- ${error}`).join('\n'));
      failed = true;
    } else {
      console.log(`${filename}: schema ${state.schemaVersion} valid`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
