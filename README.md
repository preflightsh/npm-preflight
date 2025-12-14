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

## License

MIT
