#!/usr/bin/env node
// Package the extension into a CWS-uploadable zip.
//
// Pipeline: read manifest version -> run the production build -> zip
// dist/ minus source maps -> write to dist-zip/freedocstore-v{version}.zip
//
// The same zip serves two distribution paths:
//   1. Chrome Web Store upload (unlisted listing)
//   2. Self-host download for "load unpacked" power users
// Source maps are stripped because CWS rejects review when they balloon
// the package size, and end users don't need them.
//
// Usage:
//   npm run package           # build + zip
//   node scripts/package.mjs  # same

import { readFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DIST = path.join(EXT_ROOT, 'dist');
const OUT_DIR = path.join(EXT_ROOT, 'dist-zip');

function readVersion() {
  const manifestPath = path.join(EXT_ROOT, 'manifest.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) {
    throw new Error(`manifest.json version must be semver-like, got ${m.version}`);
  }
  // CWS rejects mismatches between manifest.json and package.json
  // versions only loosely (it only reads manifest), but every release
  // checklist I've ever seen lists "bump both" as the most-forgotten
  // step. Catch the drift locally before the upload goes out and make
  // the failure mode obvious instead of silently shipping a tag that
  // doesn't match the published artifact.
  const pkgPath = path.join(EXT_ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.version !== m.version) {
    throw new Error(
      `version drift: manifest.json=${m.version}, package.json=${pkg.version}. ` +
      `Bump both to the same value before packaging.`
    );
  }
  return m.version;
}

function runBuild() {
  process.stdout.write('Building extension...\n');
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: EXT_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    throw new Error(`build failed (exit ${r.status})`);
  }
}

function ensureZipAvailable() {
  // `zip` is shipped on macOS and every Linux distro by default; keeping
  // the packager dep-free beats pulling in a JS zip lib for one command.
  // On Windows users can install via choco/scoop or use WSL.
  const r = spawnSync('zip', ['-v'], { stdio: 'ignore' });
  if (r.status !== 0) {
    throw new Error(
      'The `zip` command is required to package the extension. ' +
      'Install via your package manager (apt, brew, choco) and retry.'
    );
  }
}

function packageZip(version) {
  if (!existsSync(DIST)) {
    throw new Error(`dist/ does not exist at ${DIST}; build must have failed silently`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outName = `freedocstore-v${version}.zip`;
  const outPath = path.join(OUT_DIR, outName);

  // Overwrite any prior zip for the same version so re-runs are idempotent.
  if (existsSync(outPath)) rmSync(outPath);

  // -r recurse, -X strip extra file attrs (smaller, deterministic),
  // exclude source maps so the package stays under CWS size limits and
  // doesn't ship our internal file paths to end users.
  const r = spawnSync(
    'zip',
    ['-r', '-X', outPath, '.', '-x', '*.map'],
    { cwd: DIST, stdio: 'inherit' },
  );
  if (r.status !== 0) {
    throw new Error(`zip failed (exit ${r.status})`);
  }

  const sizeKb = Math.round(statSync(outPath).size / 1024);
  return { outPath, sizeKb };
}

function main() {
  const version = readVersion();
  ensureZipAvailable();
  runBuild();
  const { outPath, sizeKb } = packageZip(version);
  const rel = path.relative(EXT_ROOT, outPath);
  process.stdout.write(`\n\u2713 Packaged ${rel} (${sizeKb} KB)\n`);
  process.stdout.write('  Upload to Chrome Web Store: https://chrome.google.com/webstore/devconsole\n');
  process.stdout.write('  Or attach to a GitHub Release for the "Download .zip" install path.\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`\u2717 ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
