#!/usr/bin/env node

// Writes checksums.json for the version in package.json from a goreleaser
// checksums.txt:
//
//   node scripts/pin-checksums.js path/to/checksums.txt
//
// The publish workflow runs this before `npm publish`, so the package carries
// the SHA-256 of every archive install.js may download. It fails unless all
// six archives are listed, each exactly once, with a well-formed hash.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const source = process.argv[2];

if (!source) {
  console.error('usage: node scripts/pin-checksums.js <checksums.txt>');
  process.exit(64);
}

const wanted = [];
for (const [platform, ext] of [['darwin', 'tar.gz'], ['linux', 'tar.gz'], ['windows', 'zip']]) {
  for (const arch of ['amd64', 'arm64']) {
    wanted.push(`preflight_${version}_${platform}_${arch}.${ext}`);
  }
}

const found = {};
for (const line of fs.readFileSync(source, 'utf8').split('\n')) {
  const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
  if (!m || !wanted.includes(m[2])) {
    continue;
  }
  if (found[m[2]]) {
    console.error(`${source} lists ${m[2]} twice`);
    process.exit(1);
  }
  found[m[2]] = m[1];
}

const missing = wanted.filter((name) => !found[name]);
if (missing.length > 0) {
  console.error(`${source} has no SHA-256 for: ${missing.join(', ')}`);
  process.exit(1);
}

const files = {};
for (const name of wanted) {
  files[name] = found[name];
}
fs.writeFileSync(path.join(root, 'checksums.json'), `${JSON.stringify({ version, files }, null, 2)}\n`);
console.log(`Pinned ${wanted.length} checksums for ${version} in checksums.json`);
