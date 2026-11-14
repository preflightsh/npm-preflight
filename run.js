#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const binaryName = os.platform() === 'win32' ? 'preflight.exe' : 'preflight';
const binaryPath = path.join(__dirname, binaryName);

if (!fs.existsSync(binaryPath)) {
  // pnpm 10, Bun, --ignore-scripts and PREFLIGHT_SKIP_DOWNLOAD skip the
  // postinstall that downloads it.
  console.error(`preflight: the binary is missing (${binaryPath}).`);
  console.error("The package's install script did not run. Run it with:");
  console.error(`  node "${path.join(__dirname, 'install.js')}"`);
  console.error('or allow install scripts for @preflightsh/preflight and reinstall.');
  process.exit(127);
}

function couldNotStart(err) {
  console.error(`preflight: could not start ${binaryPath}: ${err.message}`);
  console.error('The binary may be damaged. Download it again with:');
  console.error(`  node "${path.join(__dirname, 'install.js')}"`);
  process.exit(127);
}

let child;
try {
  child = spawn(binaryPath, process.argv.slice(2), {
    stdio: 'inherit'
  });
} catch (err) {
  // A file that is not a program for this machine makes spawn throw here
  // instead of emitting an error event.
  couldNotStart(err);
}

function running() {
  return child.exitCode === null && child.signalCode === null;
}

// Forward the signals a supervisor (CI, a container runtime) sends only to
// this process. On a terminal, Ctrl-C and a hangup already reach the child,
// because it shares the terminal's process group; forwarding at once would
// deliver them twice and turn a clean cancel into a kill. There the signal
// is only passed on if the child is still running a moment later, which
// covers a `kill -INT` aimed at this process alone.
const forward = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const TERMINAL_GRACE_MS = 2000;
for (const sig of forward) {
  process.on(sig, () => {
    if (!running()) {
      return;
    }
    if (sig !== 'SIGTERM' && process.stdin.isTTY) {
      setTimeout(() => {
        if (running()) {
          child.kill(sig);
        }
      }, TERMINAL_GRACE_MS).unref();
      return;
    }
    child.kill(sig);
  });
}

child.on('error', couldNotStart);

// Signals that Node handles itself, so raising them here would not end this
// process: it ignores SIGPIPE, and SIGUSR1 starts the inspector.
const notFatalToNode = ['SIGPIPE', 'SIGUSR1'];

child.on('exit', (code, signal) => {
  if (signal) {
    // Die the same way, so the caller sees a killed process, not success.
    for (const sig of forward) {
      process.removeAllListeners(sig);
    }
    const status = 128 + (os.constants.signals[signal] || 0);
    if (!notFatalToNode.includes(signal)) {
      try {
        process.kill(process.pid, signal);
      } catch (err) {
        // Fall through to the exit status below.
      }
    }
    // Reached when the signal did not end this process: report it the way
    // a shell does, as 128 plus the signal number, never as 0.
    setTimeout(() => process.exit(status), 50);
    return;
  }
  process.exit(code === null ? 1 : code);
});
