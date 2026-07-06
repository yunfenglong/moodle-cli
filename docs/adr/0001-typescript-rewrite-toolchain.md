# ADR 0001: TypeScript Rewrite Toolchain

## Context

`moodle-cli` is an agent-facing command-line tool. Cold start should stay near 50 ms, but Moodle network round trips dominate real latency, so the rewrite should avoid unnecessary HTTP calls before it chases micro-optimizations.

The current Python implementation proves the product shape: reuse the user's authenticated Moodle browser session, call Moodle's internal AJAX endpoint, and fall back to page scraping when a site disables a service.

## Decision

- Runtime: Node.js >= 20 is the primary target. Bun compatibility is maintained by avoiding Node-only APIs where a portable alternative exists, and CI tests both Node and Bun.
- Distribution: publish the npm package `moodle-cli` with a single-file bundle built by `tsup` on top of esbuild. GitHub Releases may also attach standalone binaries built with `bun build --compile` for macOS arm64 and Linux x64.
- CLI framework: `commander`.
- HTTP: native `fetch`; no axios.
- HTML parsing: `node-html-parser`, because scraping is a fallback path and the dependency is smaller and faster than Cheerio for this CLI's selectors.
- Validation: `zod` validates Moodle AJAX response envelopes and selected response shapes.
- Tests: `vitest` with mocked `fetch` fixtures. Tests must not touch the real Moodle network.
- Code location: TypeScript lives at the repo root with `package.json`, `src/`, and `tests/`. The Python package stayed untouched until parity, then the release-pipeline slice removed it.

## Alternatives

- Bun-only runtime: rejected. Bun is a useful compatibility and binary target, but Node remains the safest default runtime for npm users and CI coverage.
- Cheerio for scraping: rejected. It is familiar, but heavier than this fallback path needs.
- Click-style yargs CLI: rejected. Commander maps cleanly to the existing command tree, aliases, generated help, and generated skill documentation.

## Consequences

The CLI now has one JavaScript distribution path for npm, npx, Node, and Bun. Keeping browser-cookie extraction and subprocess fallbacks in small modules protects Bun compatibility while still supporting the practical desktop auth path. The test suite can validate command behavior with deterministic fetch fixtures instead of requiring a real Moodle site.
