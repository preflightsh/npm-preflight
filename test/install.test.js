// Tests for install.js and run.js. Downloads are served from fixtures by
// test/stub.js, and the "binary" is a shell script, so nothing here needs
// the network or a real release. The Windows paths are covered by the CI
// job that installs the real release instead.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const skip = os.platform() === 'win32' ? 'covered by the release install job on Windows' : false;

const platform = os.platform() === 'darwin' ? 'darwin' : 'linux';
const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
const archive = `preflight_${version}_${platform}_${arch}.tar.gz`;

const FAKE_BINARY = `#!/bin/sh
case "$1" in
  version) echo "preflight version ${version}" ;;
  code) exit "$2" ;;
  signal) kill -s "$2" $$ ;;
  args) printf '%s\\n' "$@" ;;
  wait) sleep 30 & pid=$!; trap 'kill $pid; exit 42' INT TERM; echo ready; wait ;;
esac
`;

// project makes a copy of the package in a temp dir, next to a fixture
// directory holding an archive and its checksums.txt.
function project(t, { binary = FAKE_BINARY, member = 'preflight' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, 'pkg');
  const fixtures = path.join(dir, 'fixtures');
  const stage = path.join(dir, 'stage');
  for (const d of [pkg, fixtures, stage]) fs.mkdirSync(d);
  for (const f of ['install.js', 'run.js', 'package.json']) {
    fs.copyFileSync(path.join(root, f), path.join(pkg, f));
  }
  fs.writeFileSync(path.join(stage, member), binary, { mode: 0o755 });
  execFileSync('tar', ['-czf', path.join(fixtures, archive), '-C', stage, member]);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(fixtures, archive))).digest('hex');
  fs.writeFileSync(path.join(fixtures, 'checksums.txt'), `${sum}  ${archive}\n`);
  return { dir, pkg, fixtures, sum, log: path.join(dir, 'requests.log') };
}

function env(p, extra) {
  const base = Object.assign({}, process.env);
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'npm_config_https_proxy',
    'npm_config_proxy', 'npm_config_noproxy', 'PREFLIGHT_SKIP_DOWNLOAD', 'PREFLIGHT_NPM_EXTRACTOR']) {
    delete base[name];
  }
  return Object.assign(base, { PF_TEST_FIXTURES: p.fixtures, PF_TEST_LOG: p.log }, extra);
}

function install(p, extra) {
  return spawnSync(process.execPath, ['--require', path.join(__dirname, 'stub.js'), 'install.js'], {
    cwd: p.pkg, env: env(p, extra), encoding: 'utf8',
  });
}

function run(p, args, options) {
  return spawnSync(process.execPath, ['run.js', ...args], Object.assign({ cwd: p.pkg, encoding: 'utf8' }, options));
}

function requests(p) {
  return fs.existsSync(p.log) ? fs.readFileSync(p.log, 'utf8').trim().split('\n') : [];
}

function pin(p, files, pinnedVersion = version) {
  fs.writeFileSync(path.join(p.pkg, 'checksums.json'), JSON.stringify({ version: pinnedVersion, files }));
}

// refused asserts a failed install left nothing behind.
function refused(p, result, message) {
  assert.strictEqual(result.status, 1, result.stderr);
  assert.match(result.stderr, message);
  assert.deepStrictEqual(fs.readdirSync(p.pkg).filter((f) => f.startsWith('preflight')), []);
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'a failure must not print a stack trace');
}

test('installs from the release checksums.txt when the package pins nothing', { skip }, (t) => {
  const p = project(t);
  const result = install(p);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(requests(p), ['checksums.txt', archive]);
  assert.strictEqual(fs.statSync(path.join(p.pkg, 'preflight')).mode & 0o777, 0o755);
  assert.strictEqual(run(p, ['version']).stdout, `preflight version ${version}\n`);
});

test('a checksum mismatch installs nothing', { skip }, (t) => {
  const p = project(t);
  fs.writeFileSync(path.join(p.fixtures, 'checksums.txt'), `${'0'.repeat(64)}  ${archive}\n`);
  refused(p, install(p), /Checksum mismatch/);
});

test('a checksums.txt without the archive installs nothing', { skip }, (t) => {
  const p = project(t);
  fs.writeFileSync(path.join(p.fixtures, 'checksums.txt'), `${p.sum}  something-else.tar.gz\n`);
  refused(p, install(p), /no entry for/);
});

test('pinned checksums are used without fetching checksums.txt', { skip }, (t) => {
  const p = project(t);
  pin(p, { [archive]: p.sum });
  // A checksums.txt that disagrees must not matter: it is not consulted.
  fs.writeFileSync(path.join(p.fixtures, 'checksums.txt'), `${'0'.repeat(64)}  ${archive}\n`);
  const result = install(p);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(requests(p), [archive]);
});

test('a wrong pinned checksum installs nothing, whatever checksums.txt says', { skip }, (t) => {
  const p = project(t);
  pin(p, { [archive]: '0'.repeat(64) });
  refused(p, install(p), /Checksum mismatch/);
  assert.deepStrictEqual(requests(p), [archive]);
});

test('pinned checksums for another version are an error, not a fallback', { skip }, (t) => {
  const p = project(t);
  pin(p, { [archive]: p.sum }, '0.0.1');
  refused(p, install(p), /is for version 0\.0\.1/);
  assert.deepStrictEqual(requests(p), []);
});

test('pinned checksums without this archive are an error', { skip }, (t) => {
  const p = project(t);
  pin(p, {});
  refused(p, install(p), /no SHA-256 for/);
});

test('an archive without the binary installs nothing', { skip }, (t) => {
  const p = project(t, { member: 'README' });
  refused(p, install(p), /has no preflight file/);
});

test('PREFLIGHT_SKIP_DOWNLOAD installs the package without the binary', { skip }, (t) => {
  const p = project(t);
  const result = install(p, { PREFLIGHT_SKIP_DOWNLOAD: '1' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(requests(p), []);
  const ran = run(p, ['version']);
  assert.strictEqual(ran.status, 127);
  assert.match(ran.stderr, /binary is missing/);
});

test('being offline fails with a message that names the opt-out', { skip }, (t) => {
  const p = project(t);
  refused(p, install(p, { PF_TEST_OFFLINE: '1' }), /ENOTFOUND[\s\S]*PREFLIGHT_SKIP_DOWNLOAD=1/);
});

test('an unsupported platform or architecture gets a sentence, not a stack trace', { skip }, (t) => {
  const p = project(t);
  refused(p, install(p, { PF_TEST_PLATFORM: 'freebsd' }), /no build for the freebsd platform/);
  refused(p, install(p, { PF_TEST_ARCH: 'ia32' }), /no build for the ia32 architecture/);
  assert.deepStrictEqual(requests(p), []);
});

test('downloads go through HTTPS_PROXY unless NO_PROXY exempts the host', { skip }, async (t) => {
  const p = project(t);
  const asked = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    asked.push(`${req.url} ${req.headers['proxy-authorization'] || ''}`.trim());
    // The stub never uses the tunnel, so close it: an open socket would
    // keep the installer alive.
    socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const url = `http://user:pa%20ss@127.0.0.1:${proxy.address().port}`;

  // The proxy lives in this process, so the installer must run without
  // blocking it: spawn, not spawnSync.
  const viaProxy = (extra) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--require', path.join(__dirname, 'stub.js'), 'install.js'], {
      cwd: p.pkg, env: env(p, extra), stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  });

  assert.strictEqual((await viaProxy({ HTTPS_PROXY: url })).status, 0);
  const login = `Basic ${Buffer.from('user:pa ss').toString('base64')}`;
  assert.deepStrictEqual(asked, [`github.com:443 ${login}`, `github.com:443 ${login}`]);

  asked.length = 0;
  fs.rmSync(path.join(p.pkg, 'preflight'));
  assert.strictEqual((await viaProxy({ HTTPS_PROXY: url, NO_PROXY: 'example.com, .github.com' })).status, 0);
  assert.deepStrictEqual(asked, []);

  // A proxy that refuses is an install failure with a readable reason.
  proxy.removeAllListeners('connect');
  proxy.on('connect', (req, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));
  fs.rmSync(path.join(p.pkg, 'preflight'));
  refused(p, await viaProxy({ HTTPS_PROXY: url }), /refused the connection to github\.com:443: HTTP 407/);
});

test('the wrapper passes arguments, exit codes, and signals through', { skip }, (t) => {
  const p = project(t);
  assert.strictEqual(install(p).status, 0);

  assert.strictEqual(run(p, ['args', 'a b', '$x;y']).stdout, 'args\na b\n$x;y\n');
  assert.strictEqual(run(p, ['code', '3']).status, 3);
  assert.strictEqual(run(p, ['code', '64']).status, 64);

  // A fatal signal kills the wrapper the same way.
  for (const signal of ['TERM', 'KILL', 'HUP']) {
    assert.strictEqual(run(p, ['signal', signal]).signal, `SIG${signal}`);
  }
  // Node ignores SIGPIPE and turns SIGUSR1 into "start the inspector", so
  // the wrapper cannot die of them. It must still not report success.
  for (const signal of ['PIPE', 'USR1']) {
    const result = run(p, ['signal', signal]);
    assert.strictEqual(result.status, 128 + os.constants.signals[`SIG${signal}`], `SIG${signal}`);
    assert.doesNotMatch(result.stderr, /Debugger listening/);
  }
});

test('a signal sent only to the wrapper reaches the binary', { skip }, async (t) => {
  const p = project(t);
  assert.strictEqual(install(p).status, 0);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const child = spawn(process.execPath, ['run.js', 'wait'], { cwd: p.pkg, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve) => child.stdout.once('data', resolve));
    child.kill(signal);
    const [code] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
    assert.strictEqual(code, 42, `${signal}: the binary handles the signal and its exit code comes back`);
  }
});

test('a damaged binary is reported, with the way to fetch it again', { skip }, (t) => {
  const p = project(t);
  fs.writeFileSync(path.join(p.pkg, 'preflight'), Buffer.from([0x00, 0x01, 0x02, 0x03]), { mode: 0o755 });
  const result = run(p, ['version']);
  assert.strictEqual(result.status, 127, result.stderr);
  assert.match(result.stderr, /could not start[\s\S]*install\.js/);
});

test('a missing binary is reported, with the way to fetch it', { skip }, (t) => {
  const p = project(t);
  const result = run(p, ['version']);
  assert.strictEqual(result.status, 127);
  assert.match(result.stderr, /binary is missing[\s\S]*install\.js/);
});
