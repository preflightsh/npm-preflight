# preflightsh

NPM package for [Preflight.sh](https://preflight.sh) - a CLI tool that scans your codebase for launch readiness.

## Installation

```bash
npm install -g preflightsh
```

Or use with npx:

```bash
npx preflightsh scan
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

## What It Checks

- ENV parity between `.env` and `.env.example`
- Health endpoints
- Dependency vulnerabilities
- SEO metadata
- Security headers
- SSL certificates
- Secret scanning
- Favicon and icons
- robots.txt, sitemap.xml, llms.txt
- And more...

## More Info

- Website: [preflight.sh](https://preflight.sh)
- Source: [github.com/preflightsh/preflight.sh](https://github.com/preflightsh/preflight.sh)
- Issues: [github.com/preflightsh/preflight.sh/issues](https://github.com/preflightsh/preflight.sh/issues)

## License

MIT
