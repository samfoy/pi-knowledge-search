# Changelog

## Unreleased

### Fixed

- A background sync that changed nothing no longer marks the index stale. The worker writes
  `index.json` only when files were added, updated or removed, so after a no-op sync the next
  `knowledge_search` or `kb_read` call no longer parses the whole index again.

## 1.3.8

### Fixed

- The index is read on first use instead of at every session start. Parsing a large `index.json`
  (243 MB here) blocked pi's event loop for about 3.4 s in every pi process, including headless
  sub-agents, and again after every background sync. `knowledge_search`, `kb_read`,
  `/knowledge-overview` and `/knowledge-reindex` now load it on demand; a completed sync marks it
  stale so the next call re-reads it. The startup overview, when enabled, still loads it at start.

## 1.3.7

Covers everything since 1.3.5, the last version on npm. 1.3.6 was tagged in
`package.json` on GitHub, but its publish failed and it never reached npm; its
changes ship here.

### Fixed

- Embedding and sync-worker errors now go through pi's managed UI
  (`ctx.ui.notify`) when a TUI is present, and not through raw `console.error`,
  which corrupted the input box. Per-chunk embedding failures are collapsed into
  one "failed for N/M chunks" line per batch. (#14)
- Distinct embedding error messages are reported, capped at 3 with "+N more",
  not just the last one. Worker stderr diagnostics are surfaced as a warning on a
  clean exit too. (#15)
- The `@aws-sdk/*` optional dependencies are unpinned (`^3.700.0`). The exact
  `3.750.0` pin forced the vulnerable `fast-xml-parser` 4.4.1 and `uuid` 9.0.1
  into the tree; neither package is installed any more. (#16)
- `tsx` moved from `dependencies` to `devDependencies`. Only the test script
  uses it, so installs no longer pull tsx and its esbuild binaries.
- `pi install git:github.com/samfoy/pi-knowledge-search` works again. The
  `prepare` script ran esbuild, a devDependency, under `npm install --omit=dev`.
  It is now `prepack`; `dist/` is committed, so git installs need no build.
- The Node floor is stated correctly. The README and the FTS5 startup error said
  Node 24+, but Node's bundled SQLite has had FTS5 since 22.16. Both now say
  Node 22.19+, pi's own floor.

### Changed

- The schema import moved from `@sinclair/typebox` to bare `typebox` (TypeBox
  1.x). The peer dependency is now `typebox: "*"`. The `@sinclair/typebox`
  esbuild externals are gone.
- `engines.node` is `>=22.19.0` (1.3.5 declared `>=24`). The full test suite
  passes on Node 22.19.0.
- `package-lock.json` was regenerated against registry.npmjs.org. The previous
  lockfile resolved through a private mirror that CI cannot reach.
- Test files (`src/*.test.ts`) are no longer included in the npm tarball. `src/`
  is still shipped, because pi-total-recall loads `src/index.ts`.
- Publishing uses npm trusted publishing (OIDC) from `publish.yml`. A new CI
  workflow runs lint, format check, typecheck, tests, the build, and a
  committed-`dist/` freshness check.
- Added a `LICENSE` file (MIT), `homepage`, `bugs`, `author`, and more
  keywords. `@earendil-works/pi-coding-agent` and `typebox` are
  devDependencies for typechecking and remain `"*"` peers.
- The whole tree is formatted with prettier.
