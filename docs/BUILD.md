# Build Instructions

This guide is for developers who want to build `wreq-js` from source. If you just want to use the library, see the main [README.md](../README.md) — pre-built binaries are included with the npm package.

## Prerequisites

1. **[Install Rust](https://rust-lang.org/tools/install)** (includes Cargo)
2. **Node.js 20+** (check with `node --version`)

That's it! The `wreq` crate handles BoringSSL internally — no CMake or OpenSSL dev libraries needed.

## Building

### Quick Start

```bash
npm install
npm run build
```

This runs:
1. `npm run build:rust` — compiles Rust code to `rust/*.node`
2. `npm run build:ts` — compiles TypeScript to `dist/`

### Individual Builds

```bash
# Rust only
npm run build:rust

# TypeScript only
npm run build:ts
```

### Clean Build

```bash
npm run clean    # removes dist/, rust/target/, rust/*.node
npm run build
```

## Testing

```bash
npm test
```

Runs the full build, starts a local test server, and runs tests.

## Platform-Specific Notes

### macOS

Install Xcode Command Line Tools if you haven't already:

```bash
xcode-select --install
```

### Linux

Standard build tools are usually sufficient:

```bash
# Ubuntu/Debian
sudo apt-get install build-essential

# Fedora/RHEL
sudo dnf install gcc
```

### Windows

- Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with C++ support
- Or use WSL2 (recommended)

## Troubleshooting

### "Cannot find module 'index.node'"

The Rust addon wasn't built:

```bash
npm run build:rust
```

### Rust compilation errors

Update your Rust toolchain:

```bash
rustup update stable
```

### Clean slate

```bash
npm run clean
rm -rf node_modules package-lock.json
npm install
npm run build
```
