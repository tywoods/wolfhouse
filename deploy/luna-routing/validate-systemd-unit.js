'use strict';

const fs = require('fs');
const path = require('path');

const UNIT = 'luna-routing-controller.service';
const SEARCH_PATHS = Object.freeze([
  '/etc/systemd/system.control',
  '/run/systemd/system.control',
  '/run/systemd/transient',
  '/run/systemd/generator.early',
  '/etc/systemd/system',
  '/etc/systemd/system.attached',
  '/run/systemd/system',
  '/run/systemd/system.attached',
  '/run/systemd/generator',
  '/usr/local/lib/systemd/system',
  '/usr/lib/systemd/system',
  '/lib/systemd/system',
  '/run/systemd/generator.late',
]);

function applicableDropInNames(unit = UNIT) {
  const dot = unit.lastIndexOf('.');
  if (dot <= 0) throw new Error(`invalid systemd unit name: ${unit}`);
  const stem = unit.slice(0, dot);
  const type = unit.slice(dot + 1);
  const names = [`${type}.d`];
  for (let index = stem.indexOf('-'); index >= 0; index = stem.indexOf('-', index + 1)) {
    names.push(`${stem.slice(0, index + 1)}.${type}.d`);
  }
  names.push(`${unit}.d`);
  return [...new Set(names)];
}

function rooted(root, absolutePath) {
  return path.join(root, absolutePath.replace(/^\/+/, ''));
}

function existsIncludingDanglingSymlink(candidate) {
  try { fs.lstatSync(candidate); return true; } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertCanonicalUnitLayout(root = '/') {
  for (const searchPath of SEARCH_PATHS) {
    for (const dropIn of applicableDropInNames()) {
      const candidate = rooted(root, path.join(searchPath, dropIn));
      if (existsIncludingDanglingSymlink(candidate)) {
        throw new Error(`controller service overrides are unsupported: ${path.join(searchPath, dropIn)}`);
      }
    }
    const unitPath = rooted(root, path.join(searchPath, UNIT));
    if (searchPath !== '/etc/systemd/system' && existsIncludingDanglingSymlink(unitPath)) {
      throw new Error(`noncanonical controller unit is unsupported: ${path.join(searchPath, UNIT)}`);
    }
  }
}

function assertEffectiveUnit(fragmentPath, dropInPaths, environmentFiles) {
  if (fragmentPath !== '/etc/systemd/system/luna-routing-controller.service') {
    throw new Error(`effective controller unit is noncanonical: ${fragmentPath}`);
  }
  if (dropInPaths !== '') throw new Error('effective controller unit has unsupported drop-ins');
  if (environmentFiles !== '/etc/luna-routing/controller.env (ignore_errors=no)') {
    throw new Error('effective controller environment files are noncanonical');
  }
}

if (require.main === module) {
  try {
    if (process.argv[2] === '--effective') assertEffectiveUnit(process.argv[3] || '', process.argv[4] || '', process.argv[5] || '');
    else assertCanonicalUnitLayout(process.argv[2] || '/');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { UNIT, SEARCH_PATHS, applicableDropInNames, assertCanonicalUnitLayout, assertEffectiveUnit };
