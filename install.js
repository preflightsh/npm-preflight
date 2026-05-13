#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const REPO = 'preflightsh/preflight';
const VERSION = require('./package.json').version;

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

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        download(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function install() {
  const platform = getPlatform();
  const arch = getArch();

  const ext = platform === 'windows' ? 'zip' : 'tar.gz';
  const filename = `preflight_${VERSION}_${platform}_${arch}.${ext}`;
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${filename}`;

  console.log(`Downloading preflight v${VERSION} for ${platform}/${arch}...`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const archivePath = path.join(tmpDir, filename);

  try {
    await download(url, archivePath);

    const binDir = __dirname;
    const binaryName = platform === 'windows' ? 'preflight.exe' : 'preflight';

    if (ext === 'tar.gz') {
      execSync(`tar -xzf "${archivePath}" -C "${binDir}"`, { stdio: 'ignore' });
    } else {
      // Windows doesn't ship with `unzip`. PowerShell's Expand-Archive is
      // built into Windows 10+ and Windows Server 2016+.
      const psCmd = `Expand-Archive -Force -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${binDir.replace(/'/g, "''")}'`;
      execSync(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, { stdio: 'ignore' });
    }

    const binaryPath = path.join(binDir, binaryName);

    if (platform !== 'windows') {
      fs.chmodSync(binaryPath, 0o755);
    }

    console.log('Preflight installed successfully!');
  } catch (error) {
    console.error('Failed to install preflight:', error.message);
    process.exit(1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

install();
