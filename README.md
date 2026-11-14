# @preflightsh/preflight

npm package for [Preflight.sh](https://preflight.sh) - a CLI tool that scans your codebase for launch readiness.

## Installation

```bash
npm install -g @preflightsh/preflight
```

Or use with npx:

```bash
npx @preflightsh/preflight scan
```

Installing downloads the Preflight binary for your platform (macOS, Linux, or Windows, on x64 or arm64) from the matching [GitHub release](https://github.com/preflightsh/preflight/releases) and checks it against a SHA-256 that ships inside this package. Node.js 18 or later is required.

### Behind a proxy, or offline

The download honours `HTTPS_PROXY` (or `https_proxy`, or npm's own `https-proxy` and `proxy` settings) and `NO_PROXY`.

On a machine with no route to GitHub, set `PREFLIGHT_SKIP_DOWNLOAD=1` and the package installs without the binary. `preflight` then tells you how to fetch it once you can:

```bash
PREFLIGHT_SKIP_DOWNLOAD=1 npm install -g @preflightsh/preflight
```

### pnpm, Bun, and `--ignore-scripts`

These skip install scripts by default, so the binary is not downloaded. `preflight` says so when you run it and prints the one command that fetches it. To allow the script up front, add `@preflightsh/preflight` to `onlyBuiltDependencies` (pnpm) or `trustedDependencies` (Bun).

## Usage

```bash
# Initialize in your project directory
preflight init

# Run all checks
preflight scan

# Run in CI mode with JSON output
preflight scan --ci --format json
```

## Documentation

For full documentation, supported checks, and configuration options, see the main repository:

https://github.com/preflightsh/preflight

## Development

`package.json` carries a placeholder version in git. The publish workflow sets the real version, writes `checksums.json` from the CLI release, installs and runs the result, and only then publishes.

```bash
node --test test/install.test.js   # stubbed tests, no network
```

CI installs the latest CLI release with this package on Linux, macOS, and Windows.

## License

MIT
