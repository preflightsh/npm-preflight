#!/usr/bin/env node

// Prints the npm dist-tag a version should be published under:
//
//   node scripts/dist-tag.js <version> <current latest, or empty>
//
// A prerelease goes to "next" so it never becomes what
// `npm install -g @preflightsh/preflight` resolves to. A stable version
// becomes "latest" only when it is newer than the current latest; a backport
// (1.0.2 published after 1.1.0) gets "release-1.0" so it cannot move latest
// backwards.

const [version, latest] = process.argv.slice(2);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.]+)?$/;

function parse(text, what) {
  const m = SEMVER.exec(text);
  if (!m) {
    console.error(`${what} is not a semver version: ${JSON.stringify(text)}`);
    process.exit(64);
  }
  return { numbers: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: Boolean(m[4]) };
}

const v = parse(version || '', 'version');
if (v.prerelease) {
  console.log('next');
} else if (!latest) {
  console.log('latest');
} else {
  const l = parse(latest, 'latest');
  const diff = v.numbers[0] - l.numbers[0] || v.numbers[1] - l.numbers[1] || v.numbers[2] - l.numbers[2];
  // A stable release of the version latest is a prerelease of is newer too.
  const newer = diff > 0 || (diff === 0 && l.prerelease);
  console.log(newer ? 'latest' : `release-${v.numbers[0]}.${v.numbers[1]}`);
}
