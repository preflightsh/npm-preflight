#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const binaryName = os.platform() === 'win32' ? 'preflight.exe' : 'preflight';
const binaryPath = path.join(__dirname, binaryName);

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: 'inherit'
});

child.on('close', (code) => {
  process.exit(code);
});
