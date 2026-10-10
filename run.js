#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const binaryName = os.platform() === 'win32' ? 'preflight.exe' : 'preflight';
const binaryPath = path.join(__dirname, binaryName);

if (!fs.existsSync(binaryPath)) {
  // pnpm 10, Bun and --ignore-scripts skip the postinstall that downloads it.
  console.error(`preflight: the binary is missing (${binaryPath}).`);
  console.error("The package's install script did not run. Run it with:");
  console.error(`  node "${path.join(__dirname, 'install.js')}"`);
  console.error('or allow install scripts for @preflightsh/preflight and reinstall.');
  process.exit(127);
}

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: 'inherit'
});

// The child shares the terminal, so Ctrl-C already reaches it; forward the
// signals a supervisor (CI, a container runtime) sends only to this process.
const forward = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const sig of forward) {
  process.on(sig, () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(sig);
    }
  });
}

child.on('error', (err) => {
  console.error(`preflight: could not start ${binaryPath}: ${err.message}`);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  if (signal) {
    // Die the same way, so the caller sees a killed process, not success.
    for (const sig of forward) {
      process.removeAllListeners(sig);
    }
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});
