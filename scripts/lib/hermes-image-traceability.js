'use strict';

/**
 * Hermes staging image traceability helpers.
 */

const ACR_HOST = 'whstagingacr.azurecr.io';
const IMAGE_NAME = 'wh-hermes-staging';
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

function assertHermesImageRef(image, expectedFullSha) {
  const raw = String(image || '').trim();
  if (!raw) {
    return { ok: false, error: 'missing_hermes_image' };
  }
  if (/:latest$/i.test(raw) || /\/latest$/i.test(raw)) {
    return { ok: false, error: 'refuses_latest' };
  }
  const m = raw.match(/^([^/]+)\/([^:]+):(.+)$/);
  if (!m) {
    return { ok: false, error: 'unqualified_or_malformed' };
  }
  const [, host, name, tag] = m;
  if (host !== ACR_HOST) {
    return { ok: false, error: 'wrong_registry' };
  }
  if (name !== IMAGE_NAME) {
    return { ok: false, error: 'wrong_image_name' };
  }
  if (!FULL_SHA_RE.test(tag)) {
    return { ok: false, error: 'tag_not_full_sha' };
  }
  const expected = String(expectedFullSha || '').trim().toLowerCase();
  if (!FULL_SHA_RE.test(expected)) {
    return { ok: false, error: 'expected_sha_invalid' };
  }
  if (tag.toLowerCase() !== expected) {
    return { ok: false, error: 'sha_mismatch' };
  }
  return {
    ok: true,
    image: raw,
    registry: host,
    name,
    tag: tag.toLowerCase(),
  };
}

function buildHermesImage(fullSha) {
  const sha = String(fullSha || '').trim().toLowerCase();
  if (!FULL_SHA_RE.test(sha)) {
    throw new Error('full_sha_required');
  }
  return `${ACR_HOST}/${IMAGE_NAME}:${sha}`;
}

module.exports = {
  ACR_HOST,
  IMAGE_NAME,
  FULL_SHA_RE,
  assertHermesImageRef,
  buildHermesImage,
};
