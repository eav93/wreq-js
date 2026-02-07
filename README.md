# wreq-js

[![npm](https://img.shields.io/npm/v/wreq-js.svg)](https://www.npmjs.com/package/wreq-js)
[![CI](https://github.com/sqdshguy/wreq-js/actions/workflows/test.yml/badge.svg)](https://github.com/sqdshguy/wreq-js/actions/workflows/test.yml)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/sqdshguy/wreq-js)

Node.js/TypeScript HTTP client with browser TLS fingerprint impersonation (JA3/JA4). Bypass Cloudflare, DataDome, and other anti-bot TLS fingerprinting. Rust-powered via [wreq](https://github.com/0x676e67/wreq).

- **Bypass anti-bot TLS detection** (Cloudflare, DataDome, Akamai, etc.)
- Native Rust performance (no browser/process spawning)
- Real browser TLS fingerprints (JA3/JA4)
- HTTP/2 impersonation (SETTINGS/PRIORITY/header ordering)
- Multiple browser profiles (Chrome/Firefox/Safari/Edge/Opera/OkHttp)
- `fetch()`-compatible API with sessions, cookies, and proxies
- WebSocket support with fingerprint consistency
- Prebuilt native binaries for macOS/Linux/Windows
- TypeScript-first with generated definitions

## Alternatives comparison

| Library | Approach | Language | Browser profiles |
|---------|----------|----------|-----------------|
| **wreq-js** | Rust native bindings ([wreq](https://github.com/0x676e67/wreq)) | TypeScript/Node.js | Chrome, Firefox, Safari, Edge, Opera, OkHttp |
| [CycleTLS](https://github.com/Danny-Dasilva/CycleTLS) | Go subprocess | JavaScript | Chrome, Firefox |
| [got-scraping](https://github.com/apify/got-scraping) | Pure JS header tweaking | JavaScript | Limited |
| [node-tls-client](https://github.com/Sahil1337/node-tls-client) | Go shared lib (bogdanfinn) | JavaScript | Chrome, Firefox, Safari |
| [curl-impersonate](https://github.com/lwthiker/curl-impersonate) | Modified curl binary | CLI/bindings | Chrome, Firefox |

## Documentation

All guides, concepts, and API reference live at:

- https://wreq.sqdsh.win

(If you're looking for examples, sessions/cookies, proxy usage, streaming, WebSockets, or the full API surface - it's all there.)

## Installation

```bash
npm install wreq-js
# or
yarn add wreq-js
pnpm add wreq-js
bun add wreq-js
```

Prebuilt binaries are provided for:
- macOS (Intel & Apple Silicon)
- Linux (x64 & ARM64, glibc & musl)
- Windows (x64)

If a prebuilt binary for your platform/commit is unavailable, the package will build from source (requires a Rust toolchain).

## Quick start

```ts
import { fetch } from 'wreq-js';

const res = await fetch('https://example.com/api', {
  browser: 'chrome_142',
  os: 'windows',
});

console.log(await res.json());
```

## Use sessions (recommended)

For **most real-world workloads**, start with a session and reuse it across requests.
This keeps TLS/cookies warm and avoids paying setup costs on every call.

```ts
import { createSession } from 'wreq-js';

const session = await createSession({ browser: 'chrome_142', os: 'windows' });

try {
  const a = await session.fetch('https://example.com/a');
  const b = await session.fetch('https://example.com/b');
  console.log(a.status, b.status);
} finally {
  await session.close();
}
```

More session patterns: https://wreq.sqdsh.win

## When to use

Use `wreq-js` when you need to make HTTP requests that pass Cloudflare, DataDome, or other anti-bot TLS fingerprinting checks without spinning up a real browser. It's a drop-in `fetch()` replacement that impersonates real browser TLS/HTTP2 fingerprints at the network level.

If you need DOM/JS execution, CAPTCHA solving, or full browser automation, use Playwright/Puppeteer instead.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Origins

This is a maintained fork of [will-work-for-meal/node-wreq](https://github.com/will-work-for-meal/node-wreq) (originally named `node-wreq`), with ongoing updates, compatibility fixes, and performance work.

## Acknowledgments

- [wreq](https://github.com/0x676e67/wreq) - Rust HTTP client with browser impersonation
- [wreq-util](https://github.com/0x676e67/wreq-util) - source of up-to-date browser profiles
- [Neon](https://neon-bindings.com/) - Rust ↔ Node.js bindings
