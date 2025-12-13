# Benchmarking

This repo includes a local benchmark runner that starts a local HTTP server and measures request throughput across multiple samples, reporting a 95% confidence interval so you can tell whether a change is above the noise floor.

## Run

Build + run:

```bash
npm run bench
```

Run (assumes you already built `dist/` and the native addon):

```bash
npm run bench:run
```

Quick sanity run:

```bash
npm run bench:quick
```

Write results to JSON (useful for comparing runs):

```bash
npm run bench:run -- --json ./bench-results.json
```

## Key options

```bash
npm run bench:run -- --duration-ms 2000 --samples 15 --warmup 3 --concurrency 32
```

- `--duration-ms`: Longer samples reduce noise.
- `--samples`: More samples reduce confidence interval width.
- `--concurrency`: Lower if you suspect the local server or your machine is saturated.

## Scenarios

The default run includes:

- `wreq.session.get.small` - Session fetch, tiny response body (connection reuse).
- `wreq.session.get.4kb` - Session fetch, 4KB response body.
- `wreq.session.post.32b` - Session fetch, 32B POST body (server validates length).
- `wreq.isolated.get.small` - Isolated `fetch()` (no connection reuse).
- `node.fetch.get.small` - Node's built-in `fetch()` for sanity/reference.

Select a subset:

```bash
npm run bench:run -- --scenario wreq.session.get.small --scenario wreq.session.get.4kb
```

## Making results comparable

- Run on the same machine, on AC power, with minimal background load.
- Prefer longer `--duration-ms` and more `--samples` until the reported CI margin is comfortably smaller than the improvement you’re targeting.
- Keep parameters constant when comparing optimizations.
