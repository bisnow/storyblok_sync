# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A reusable GitHub Action that promotes Storyblok **components, assets and stories** from a dev space to a prod space via the Management API (MAPI), remapping every cross-space reference (story `parent_id`/links, asset `id`/`filename`, component group/tag/preset/whitelist ids) along the way. Developers declare *what* to promote in small JSON files under `.storyblok_sync/` in their app repo; the action reads them at runtime.

The action is **stateless** — there is no committed manifest. Idempotency comes from matching existing prod content by natural key each run (stories by `full_slug`, components by `name`, assets by `short_filename`) and updating instead of creating. Source→target id maps are built in memory per run.

## Commands

```bash
npm ci                       # install
npm test                     # vitest run (all tests)
npm run test:watch           # vitest watch mode
npx vitest run src/stories/ref-mapper.test.ts   # single test file
npx vitest run -t 'bridges'  # single test by name pattern
npm run typecheck            # tsc --noEmit (strict, noUnusedLocals/Params)
npm run build                # ncc bundle src/main.ts → dist/index.js (CJS)
npm run package              # build + fail if dist/ has uncommitted changes
```

## The dist/ bundle is committed — and load-bearing

`action.yml` runs `dist/index.js` directly (`runs.using: node20`) with **no build step at runtime**, so `dist/` must always be committed and in sync with `src/`. Three things enforce this, do not fight them:

- **`.githooks/pre-commit`** rebuilds and stages `dist/` whenever a build input (`src/`, `package.json`, `package-lock.json`, `tsconfig.json`) is staged. Enabled via `npm run prepare` (sets `core.hooksPath`).
- **CI** (`.github/workflows/ci.yml`) runs typecheck → test → build, then fails if `dist/` differs from the committed copy.
- After any source change destined for a release, run `npm run build` and commit `dist/`.

`dist/` is intentionally **not** gitignored (see the comment in `.gitignore`).

## Non-obvious build/runtime constraints

- **Package is CommonJS** (`"type": "commonjs"`) so the ncc bundle runs under `node20`. Source uses ESM `import` syntax; ncc/esbuild handle that regardless. **Do NOT set `"type": "module"`** — it breaks the bundled action at runtime.
- **vitest must be ≥3** (ships Vite 6+). vitest 2 + Vite 5 emit a CJS-deprecation warning because the package is CJS.
- **HTTP tests require the installed `undici` major to match Node's built-in** (`process.versions.undici`). The repo pins both to the same Node via `.nvmrc` (Node 24 → built-in undici 7) and the `undici` devDependency (`^7`); CI reads `.nvmrc`. Only when the majors match does `setGlobalDispatcher(new MockAgent())` intercept the native global `fetch` the SDK uses — a mismatch silently fails to intercept and the request escapes to the network (ENOTFOUND). `src/http.test.ts` guards this: it fails loudly on CI and skips (with a note) on a mismatched local Node. If you bump the Node major, bump `undici` to match (and vice-versa).

## Architecture

`src/main.ts` is the entry point. It orchestrates the sync in strict **dependency order**, each phase fully completing before the next:

```
components → assets → stories → update-stories (asset-ref repair)
```

Order matters: stories validate/remap against component schemas, and asset references in story content are rewritten to prod ids — so assets must land before stories.

The full dev component set is **always** fetched (even when no components are requested) to build the name→schema map that story validation and ref-mapping depend on. A failure there is fatal.

### Core pattern: pure functions + injected-client orchestrators

The codebase is split so almost everything is unit-testable without network:

- **Pure functions** (no I/O): dependency `closure`/`graph`/`remap`, story `tree`/`validate`/`ref-mapper`/`link-bridge`, `sync-file` parse/merge/select, `paginate`, `progress`. Each `*.ts` has a colocated `*.test.ts`.
- **Orchestrators** (`*/push.ts`, `*/fetch.ts`, `assets/update-stories.ts`) take a `SyncClient` (and other collaborators like `download`, `remove`, `now`) as **injected dependencies**, so tests pass mocks via `{...} as unknown as SyncClient`.
- `src/http.test.ts` is the only test that exercises the real SDK, through undici's `MockAgent` — it covers header-driven pagination and the multi-step asset upload flow that pure tests can't reach.

`SyncClient` (in `src/types.ts`) is a `Pick` of the real MAPI client's resources, so the real client is assignable and mocks are easy.

### The three resource pipelines

**Components** (`src/components/`):
- `closure.ts` — given the named components, computes the transitive dependency closure (groups + parent groups, tags, whitelisted components recursively, presets). Pure.
- `graph.ts` — builds a dependency graph (tags → groups → components → presets), with prod resources colocated on each node by natural key. `determineProcessingOrder` topo-sorts into levels; component-only cycles become "cyclic levels" resolved with stub-create. Cycles involving groups/tags/presets throw. Uses Tarjan's SCC.
- `remap.ts` — pure per-node reference remappers (group `parent_id`, component group_uuid/tag_ids/preset_id/schema whitelists, preset `component_id`) against already-upserted prod resources. `component_whitelist` uses names (no remap); `datasource_slug` is untouched (must pre-exist in prod).
- `push.ts` — per level: PASS 1 resolve references, PASS 2 upsert (create if no `targetData`, else update). Then optionally prunes stale presets of successfully-pushed components.

**Assets** (`src/assets/`):
- `find.ts` — MAPI `search` is fuzzy; narrow to exact `short_filename`, fall back to fuzzy with a warning.
- `push.ts` — search dev → download binary → resolve folder into prod (match/create by name) → upsert. Produces **two map views**: `assetMap` keyed by **dev** id (story content references dev ids before remap) and `prodAssetMap` keyed by **prod** id for *replaced pre-existing* assets only (for update-stories). Updates re-`get` the asset to capture the new CDN filename.
- `update-stories.ts` — after assets change, repairs asset refs in *existing* prod stories not in this sync set. Single-asset changes narrow the scan via `query.reference_search`; otherwise scans all. Only updates stories whose content actually changed (deep-equality check).

**Stories** (`src/stories/`):
- `fetch.ts` — resolves requested slugs + ancestor folders to full dev stories; prefetches prod stories by natural key; fetches arbitrary dev stories by id/uuid for cross-space link resolution. Chunks by 100 (`by_slugs`/`by_ids`/`by_uuids`).
- `tree.ts` — pure: slug normalization, ancestor expansion, depth grouping (folders before non-folders per level), slug matching.
- `push.ts` — Pass 1 builds the folder/story tree (match prod by normalized `full_slug` reusing id/uuid, else create a `publish: 0` placeholder under the resolved parent). Link bridge resolves cross-space links by slug. Pass 2 remaps via `ref-mapper` and updates each story, publishing per the dev story's state.
- `ref-mapper.ts` — the heart of content remapping: dispatches by component-schema field type (asset/multiasset, multilink, bloks recurse, richtext story-links + embedded bloks, options internal_stories). Asset filenames are normalized S3→CDN via `normalizeAssetUrl`. Ported nearly verbatim from the monoblok CLI.
- `link-bridge.ts` — stateless replacement for the CLI's uuid manifest: resolves each story-link reference to its dev `full_slug`, finds the prod story with that slug, adds the mapping. Unresolvable links warn and pass through (left pointing at the dev id).
- `publish-state.ts` — listed stories publish per `devStory.published`; folders never publish. The update-stories repair pass republishes only `published && !unpublished_changes`.

### Cross-cutting libs (`src/lib/`)

- `result.ts` — `unwrap(apiResponse, context)` collapses the MAPI `{ data, error, response }` union into the data or throws a `SyncError`. Use it for every MAPI call so business logic reads linearly. `toError` narrows unknown throwables.
- `paginate.ts` — `listAll` walks pages using the `Total`/`Per-Page` response **headers** (the SDK does not auto-paginate). Pass it a `fetchPage(page)` and a `selectItems` extractor.
- `p-map.ts` — bounded-concurrency map (default 6). Only caps in-flight work/memory; the SDK already throttles to ~6 req/s, so never add throttling on top.
- `progress.ts` — `ProgressTracker` emits start/10%-bucket/end lines with ETA; clock is injectable for deterministic tests.

### MAPI response envelopes

The SDK returns `{ data, error, response, request }` with `throwOnError: false`. Envelope keys differ per resource and aren't intuitive — list vs. single, and request bodies are often wrapped (`{ component }`, `{ component_group }`, `{ preset }`, `{ asset_folder }`) while internal tags are **not** wrapped. `assets.get` returns the Asset directly; `assets.update` returns void. When touching MAPI calls, consult the `mapi-envelope-keys` memory file or the generated types under `node_modules/@storyblok/management-api-client/dist/generated/*/types.gen.d.mts`.

### Logging & debug

`src/logger.ts` wraps `@actions/core` (annotations, groups, job summary). Debug mode (`debug` input OR GitHub step-debug) makes `logger.debug` force-emit a visible line and turns on the **instrumentation Proxy** in `src/clients.ts`, which logs every MAPI call (resource.method, space, summarized args — never tokens — status, duration). When debug is off, `createInstrumentedClient` returns the bare client (zero overhead).

## Conventions

- Errors caught from MAPI use `toError(maybeError).message`; per-item failures are collected (warn + count), not thrown — partial failure is a first-class outcome. A run exits non-zero on any failure only when `fail-on-partial` (default true).
- `dry-run` performs no writes: orchestrators log the intended create/update and seed fake `targetData` so dependent phases still resolve.
- New ported logic from the monoblok CLI keeps the CLI's algorithm but drops its filesystem/stream layer in favor of pure functions — preserve that boundary.
