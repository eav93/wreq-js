# Architecture Overview

## Request Flow

```
┌─────────────────────────────────────┐
│  JavaScript/TypeScript Code         │
└──────────────┬──────────────────────┘
               ↓
┌──────────────────────────────────────┐
│  TypeScript Wrapper (wreq-js.ts)     │
│  - Validate inputs                   │
│  - Convert to options object         │
└──────────────┬───────────────────────┘
               ↓ (Neon N-API)
┌──────────────────────────────────────┐
│  Rust Native Module (lib.rs)         │
│  - Parse JS objects                  │
│  - Call Rust client                  │
│  - Convert response back to JS       │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│  Browser Client (client.rs)          │
│  - Select browser profile            │
│  - Build HTTP request                │
│  - Apply headers & options           │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│  wreq HTTP Client                    │
│  - Impersonate browser               │
│  - Custom TLS handshake              │
│  - HTTP/2 frame ordering             │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│  BoringSSL (TLS)                     │
│  - Chrome-like cipher suites         │
│  - Exact TLS extensions              │
│  - JA3/JA4 fingerprint matching      │
└──────────────┬───────────────────────┘
               ↓
┌──────────────────────────────────────┐
│  HTTP/2 Implementation               │
│  - SETTINGS frame (browser-specific) │
│  - PRIORITY streams                  │
│  - Header ordering                   │
└──────────────────────────────────────┘
```

## References

- [wreq GitHub](https://github.com/0x676e67/wreq)
- [BoringSSL](https://boringssl.googlesource.com/boringssl/)
- [JA3 Fingerprinting](https://github.com/salesforce/ja3)
- [HTTP/2 RFC](https://httpwg.org/specs/rfc7540.html)
- [Neon Bindings](https://neon-bindings.com/)
