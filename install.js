#!/usr/bin/env node

// Downloads the preflight binary for this platform from the GitHub release
// that matches this package's version, checks it against a SHA-256, and puts
// only the binary next to this file. Any failure, a checksum mismatch above
// all, leaves no binary behind and exits non-zero.
//
// The expected SHA-256 comes from checksums.json, which the publish workflow
// writes into the package, so the hash a user checks against arrived with the
// provenance-attested npm tarball and not from the same place as the binary.
// A git checkout has no such file and falls back to the release's
// checksums.txt.

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const os = require('os');

const REPO = 'preflightsh/preflight';
const VERSION = require('./package.json').version;
const PINNED = path.join(__dirname, 'checksums.json');
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60000;
// The largest archive is about 10 MB. The cap only stops a runaway response.
const MAX_BYTES = 200 * 1024 * 1024;

function getPlatform() {
  const platform = os.platform();
  switch (platform) {
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    case 'win32': return 'windows';
    default:
      throw new Error(`preflight has no build for the ${platform} platform (macOS, Linux, and Windows are supported)`);
  }
}

function getArch() {
  const arch = os.arch();
  switch (arch) {
    case 'x64': return 'amd64';
    case 'arm64': return 'arm64';
    default:
      throw new Error(`preflight has no build for the ${arch} architecture (x64 and arm64 are supported)`);
  }
}

// noProxyFor reports whether NO_PROXY exempts host. Entries are host names
// or domain suffixes, with or without a leading dot; "*" exempts everything.
function noProxyFor(host) {
  const raw = process.env.NO_PROXY || process.env.no_proxy || process.env.npm_config_noproxy || '';
  for (let entry of raw.split(',')) {
    entry = entry.trim().toLowerCase().replace(/:\d+$/, '');
    if (!entry) continue;
    if (entry === '*') return true;
    entry = entry.replace(/^\*?\./, '');
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

// proxyFor returns the proxy to reach target through, or null. It reads the
// variables curl and npm read, so an install behind a corporate proxy works
// when `npm install` itself does.
function proxyFor(target) {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.npm_config_https_proxy || process.env.npm_config_proxy || '';
  if (!raw || noProxyFor(target.hostname.toLowerCase())) {
    return null;
  }
  let proxy;
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch (err) {
    throw new Error('HTTPS_PROXY is not a URL');
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new Error(`HTTPS_PROXY must be an http or https URL, not ${proxy.protocol}`);
  }
  return proxy;
}

// openTunnel asks proxy for a CONNECT tunnel to target and resolves with the
// raw socket. TLS to the target runs inside the tunnel, so the proxy carries
// the bytes without being able to read or change them.
function openTunnel(proxy, target) {
  return new Promise((resolve, reject) => {
    const authority = `${target.hostname}:${target.port || 443}`;
    const headers = { Host: authority };
    if (proxy.username) {
      const login = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(login).toString('base64')}`;
    }
    const secure = proxy.protocol === 'https:';
    const req = (secure ? https : http).request({
      host: proxy.hostname,
      port: proxy.port || (secure ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`Timed out connecting to the proxy ${proxy.host}`)));
    req.on('error', (err) => reject(new Error(`Could not reach the proxy ${proxy.host}: ${err.message}`)));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`The proxy ${proxy.host} refused the connection to ${authority}: HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.end();
  });
}

// download fetches url into dest, following up to MAX_REDIRECTS https
// redirects. GitHub release assets redirect once to their storage host.
async function download(url, dest, hops = 0) {
  let target;
  try {
    target = new URL(url);
  } catch (err) {
    throw new Error(`Bad download URL: ${url}`);
  }
  if (target.protocol !== 'https:') {
    throw new Error(`Refusing a non-https download: ${url}`);
  }

  const options = {};
  const proxy = proxyFor(target);
  if (proxy) {
    const tunnel = await openTunnel(proxy, target).catch((err) => {
      err.download = true;
      throw err;
    });
    // With createConnection and no agent, the request uses this socket.
    // Without an agent Node also loses the https default port and would
    // send "Host: github.com:80", which GitHub answers with a redirect to
    // the same URL, so name the port.
    options.createConnection = () => tls.connect({ socket: tunnel, servername: target.hostname });
    options.defaultPort = 443;
    options.port = target.port || 443;
  }

  const redirect = await new Promise((resolve, reject0) => {
    // Mark failures to fetch, so the caller can tell them from a bad archive.
    const reject = (err) => {
      err.download = true;
      reject0(err);
    };
    const req = https.get(target, options, (response) => {
      const status = response.statusCode;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (hops >= MAX_REDIRECTS) {
          reject(new Error(`Too many redirects downloading ${url}`));
          return;
        }
        resolve(new URL(response.headers.location, target).toString());
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${status}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      let received = 0;
      const fail = (err) => {
        response.destroy();
        file.destroy();
        reject(err);
      };
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_BYTES) {
          fail(new Error(`${url} is larger than ${MAX_BYTES} bytes`));
        }
      });
      response.on('error', fail);
      file.on('error', fail);
      file.on('finish', () => file.close((err) => (err ? reject(err) : resolve(null))));
      response.pipe(file);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`Timed out downloading ${url}`)));
    req.on('error', reject);
  });

  if (redirect) {
    await download(redirect, dest, hops + 1);
  }
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

// pinnedSum reads filename's SHA-256 from the checksums.json shipped in the
// package, or returns null when the package has none (a git checkout). A
// file written for another version is an error, never a reason to fall back:
// falling back would quietly drop the pin.
function pinnedSum(filename) {
  let raw;
  try {
    raw = fs.readFileSync(PINNED, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Could not read checksums.json: ${err.message}`);
  }
  let pinned;
  try {
    pinned = JSON.parse(raw);
  } catch (err) {
    throw new Error('checksums.json is not valid JSON');
  }
  if (!pinned || pinned.version !== VERSION) {
    throw new Error(`checksums.json is for version ${pinned && pinned.version}, but this package is ${VERSION}`);
  }
  const sum = pinned.files && pinned.files[filename];
  if (typeof sum !== 'string' || !/^[0-9a-f]{64}$/.test(sum)) {
    throw new Error(`checksums.json has no SHA-256 for ${filename}`);
  }
  return sum;
}

// run executes a helper and, when it fails, puts what it printed into the
// error so the reason reaches the user.
function run(file, args, env) {
  try {
    execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
  } catch (err) {
    const said = [err.stdout, err.stderr].map((b) => (b ? b.toString().trim() : '')).filter(Boolean).join(' ');
    throw new Error(`${path.basename(file)} failed: ${said || err.message}`);
  }
}

// extractZip unpacks a zip on Windows, which has no unzip. Windows 10 1803
// and Server 2019 ship bsdtar as System32\tar.exe, and it reads zip; that is
// named by its full path because a Git for Windows tar earlier on PATH is GNU
// tar and does not. Older systems fall back to PowerShell's Expand-Archive.
// The paths reach PowerShell through the environment: everything after
// -Command is joined into the script text, so paths passed as arguments
// would be parsed as script (and $args would be empty).
function extractZip(archivePath, outDir) {
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const powershell = () => run('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    'Expand-Archive -Force -LiteralPath $env:PF_ZIP -DestinationPath $env:PF_OUT',
  ], Object.assign({}, process.env, { PF_ZIP: archivePath, PF_OUT: outDir }));

  // PREFLIGHT_NPM_EXTRACTOR picks one extractor; the CI job uses it to prove
  // each of them works.
  const only = process.env.PREFLIGHT_NPM_EXTRACTOR;
  if (only === 'powershell') {
    powershell();
    return;
  }
  if (only === 'tar' || fs.existsSync(systemTar)) {
    try {
      run(systemTar, ['-xf', archivePath, '-C', outDir]);
      return;
    } catch (err) {
      if (only === 'tar') throw err;
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir);
    }
  }
  powershell();
}

function extract(archivePath, ext, outDir) {
  if (ext === 'tar.gz') {
    run('tar', ['-xzf', archivePath, '-C', outDir]);
    return;
  }
  extractZip(archivePath, outDir);
}

async function install() {
  // For installs with no route to GitHub. The package installs without the
  // binary, and `preflight` then says how to fetch it.
  if (/^(1|true|yes)$/i.test(process.env.PREFLIGHT_SKIP_DOWNLOAD || '')) {
    console.log('PREFLIGHT_SKIP_DOWNLOAD is set: not downloading the preflight binary.');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  let staged = '';

  try {
    const platform = getPlatform();
    const arch = getArch();

    const ext = platform === 'windows' ? 'zip' : 'tar.gz';
    const filename = `preflight_${VERSION}_${platform}_${arch}.${ext}`;
    const base = `https://github.com/${REPO}/releases/download/v${VERSION}`;
    const binaryName = platform === 'windows' ? 'preflight.exe' : 'preflight';
    const binaryPath = path.join(__dirname, binaryName);

    const archivePath = path.join(tmpDir, filename);
    const checksumsPath = path.join(tmpDir, 'checksums.txt');
    const outDir = path.join(tmpDir, 'out');

    console.log(`Downloading preflight v${VERSION} for ${platform}/${arch}...`);

    let want = pinnedSum(filename);
    if (want === null) {
      await download(`${base}/checksums.txt`, checksumsPath);
      want = expectedSum(checksumsPath, filename);
    }
    await download(`${base}/${filename}`, archivePath);

    const got = sha256(archivePath);
    if (got !== want) {
      throw new Error(`Checksum mismatch for ${filename}: expected ${want}, got ${got}`);
    }

    fs.mkdirSync(outDir);
    extract(archivePath, ext, outDir);
    const extracted = path.join(outDir, binaryName);
    let isFile = false;
    try {
      isFile = fs.lstatSync(extracted).isFile();
    } catch (err) {
      // Reported below.
    }
    if (!isFile) {
      throw new Error(`${filename} has no ${binaryName} file`);
    }

    // Copy, then rename into place, so a failure never leaves half a binary.
    staged = `${binaryPath}.download`;
    fs.copyFileSync(extracted, staged);
    if (platform !== 'windows') {
      fs.chmodSync(staged, 0o755);
    }
    fs.renameSync(staged, binaryPath);
    staged = '';

    console.log('Preflight installed successfully!');
  } catch (error) {
    console.error('Failed to install preflight:', error.message);
    if (error.download) {
      console.error('To install the package without the binary, set PREFLIGHT_SKIP_DOWNLOAD=1.');
    }
    process.exitCode = 1;
  } finally {
    if (staged) {
      fs.rmSync(staged, { force: true });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

install();
