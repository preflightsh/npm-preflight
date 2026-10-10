#!/usr/bin/env node

// Downloads the preflight binary for this platform from the GitHub release
// that matches this package's version, checks it against the release's
// checksums.txt, and puts only the binary next to this file. Any failure,
// a checksum mismatch above all, leaves no binary behind and exits non-zero.

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const os = require('os');

const REPO = 'preflightsh/preflight';
const VERSION = require('./package.json').version;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60000;

function getPlatform() {
  const platform = os.platform();
  switch (platform) {
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    case 'win32': return 'windows';
    default: throw new Error(`Unsupported platform: ${platform}`);
  }
}

function getArch() {
  const arch = os.arch();
  switch (arch) {
    case 'x64': return 'amd64';
    case 'arm64': return 'arm64';
    default: throw new Error(`Unsupported architecture: ${arch}`);
  }
}

// download fetches url into dest, following up to MAX_REDIRECTS https
// redirects. GitHub release assets redirect once to their storage host.
function download(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error(`Bad download URL: ${url}`));
      return;
    }
    if (target.protocol !== 'https:') {
      reject(new Error(`Refusing a non-https download: ${url}`));
      return;
    }
    const req = https.get(target, (response) => {
      const status = response.statusCode;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (hops >= MAX_REDIRECTS) {
          reject(new Error(`Too many redirects downloading ${url}`));
          return;
        }
        const next = new URL(response.headers.location, target).toString();
        download(next, dest, hops + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${status}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      const fail = (err) => {
        response.destroy();
        file.destroy();
        reject(err);
      };
      response.on('error', fail);
      file.on('error', fail);
      file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
      response.pipe(file);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`Timed out downloading ${url}`)));
    req.on('error', reject);
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// expectedSum reads filename's SHA-256 from a goreleaser checksums.txt.
function expectedSum(checksumsPath, filename) {
  for (const line of fs.readFileSync(checksumsPath, 'utf8').split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
    if (m && m[2] === filename) {
      return m[1];
    }
  }
  throw new Error(`checksums.txt has no entry for ${filename}`);
}

function extract(archivePath, ext, outDir) {
  if (ext === 'tar.gz') {
    execFileSync('tar', ['-xzf', archivePath, '-C', outDir], { stdio: 'ignore' });
    return;
  }
  // Windows doesn't ship with `unzip`. PowerShell's Expand-Archive is built
  // into Windows 10+ and Windows Server 2016+. The paths go in as arguments,
  // never into the script text.
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -Force -LiteralPath $args[0] -DestinationPath $args[1]',
    archivePath, outDir,
  ], { stdio: 'ignore' });
}

async function install() {
  const platform = getPlatform();
  const arch = getArch();

  const ext = platform === 'windows' ? 'zip' : 'tar.gz';
  const filename = `preflight_${VERSION}_${platform}_${arch}.${ext}`;
  const base = `https://github.com/${REPO}/releases/download/v${VERSION}`;
  const binaryName = platform === 'windows' ? 'preflight.exe' : 'preflight';
  const binaryPath = path.join(__dirname, binaryName);

  console.log(`Downloading preflight v${VERSION} for ${platform}/${arch}...`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const archivePath = path.join(tmpDir, filename);
  const checksumsPath = path.join(tmpDir, 'checksums.txt');
  const outDir = path.join(tmpDir, 'out');

  try {
    await download(`${base}/checksums.txt`, checksumsPath);
    await download(`${base}/${filename}`, archivePath);

    const want = expectedSum(checksumsPath, filename);
    const got = sha256(archivePath);
    if (got !== want) {
      throw new Error(`Checksum mismatch for ${filename}: expected ${want}, got ${got}`);
    }

    fs.mkdirSync(outDir);
    extract(archivePath, ext, outDir);
    const extracted = path.join(outDir, binaryName);
    if (!fs.lstatSync(extracted).isFile()) {
      throw new Error(`${filename} has no ${binaryName} file`);
    }

    // Copy, then rename into place, so a failure never leaves half a binary.
    const staged = `${binaryPath}.download`;
    fs.copyFileSync(extracted, staged);
    if (platform !== 'windows') {
      fs.chmodSync(staged, 0o755);
    }
    fs.renameSync(staged, binaryPath);

    console.log('Preflight installed successfully!');
  } catch (error) {
    console.error('Failed to install preflight:', error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

install();
