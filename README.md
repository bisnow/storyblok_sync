# storyblok-sync

A reusable GitHub Action that promotes Storyblok **components, assets and
stories** from a dev space to a prod space via the Management API — remapping
every cross-space reference (story `parent_id`/links, asset `id`/`filename`,
component group/tag/preset/whitelist ids) along the way.

Developers declare *what* to promote in small JSON files under
`.storyblok_sync/` in their app repo; the action reads them at runtime and
upserts each item into prod in dependency order (**components → assets →
stories**), then optionally repairs asset references in other existing prod
stories.

It is **stateless**: there is no committed manifest. Idempotency comes from
matching existing prod content by natural key each run (stories by `full_slug`,
components by `name`, assets by `short_filename`) and updating instead of
creating. Source→target id maps are built in memory per run.

## Sync files

Create a JSON file in `.storyblok_sync/` named after your PR or ticket
(`CMS-353.json`). Include only the keys you need; any key may be omitted and
empty arrays are fine.

```json
{
  "components": ["style_guide_page", "cta_section"],
  "stories": ["en/style-guide", "en/blog/my-post"],
  "assets": ["hero-image.jpg", "logo.png"]
}
```

| Key | Type | Meaning |
|-----|------|---------|
| `components` | `string[]` | Snake-case component names. Their dependencies (groups, tags, whitelisted components, presets) are pulled in automatically. |
| `stories` | `string[]` | Story slugs (`full_slug`, not a URL). Ancestor folders are resolved automatically. |
| `assets` | `string[]` | Asset filenames (matched against `short_filename`). |

> Tip: if a story references an inline image, include that asset in `assets`.
> Assets always sync before stories so prod asset ids are in place before story
> references are rewritten. Likewise, to keep a cross-space story **link**
> working, include the linked story in `stories` (see [Caveats](#caveats)).

## Usage

```yaml
# .github/workflows/sync-storyblok.yml (in the APP repo)
name: Sync Storyblok content to prod

on:
  workflow_run:
    workflows: ["Deploy"]      # your deploy workflow's name:
    types: [completed]
  workflow_dispatch:

permissions:
  contents: write              # required for the commit step below

jobs:
  sync:
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main            # commit back to a real branch, not a detached SHA

      - name: Sync dev → prod
        id: sync
        uses: bisnow/storyblok_sync@v1
        with:
          dev-space-id:  '1234567'           # your source (dev) space id
          prod-space-id: '7654321'           # your target (prod) space id
          dev-token:  ${{ secrets.SB_DEV_TOKEN }}
          prod-token: ${{ secrets.SB_PROD_TOKEN }}
          clear-processed-files: true

      - name: Commit cleared sync files
        if: ${{ steps.sync.outputs.cleared-files != '' }}
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A .storyblok_sync
          git diff --staged --quiet || git commit -m "chore: clear synced storyblok files [skip ci]"
          git push
```

> **Pinning the action ref:** `@v1` tracks the latest 1.x release and picks up
> fixes automatically. For a fully reproducible build, pin to an immutable ref
> instead — `@v1.0.0` or a commit SHA.

Because the push uses the checkout's `GITHUB_TOKEN`, it won't re-trigger
workflows; the `[skip ci]` is extra insurance (and required if you swap to a PAT
or GitHub App token). The action itself performs **no git operations** — it only
deletes fully-succeeded files from the working tree and reports them via the
`cleared-files` output.

### Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `dev-space-id` | _(required)_ | Source (dev) space id. |
| `prod-space-id` | _(required)_ | Target (prod) space id. |
| `region` | `us` | Region for both spaces (`eu`/`us`/`ca`/`ap`/`cn`). Both clients are created per space — they need not share a region. |
| `dev-token` | _(required)_ | Personal access token with read access to the dev space. |
| `prod-token` | _(required)_ | Personal access token with write access to the prod space (may equal `dev-token`). |
| `sync-dir` | `.storyblok_sync` | Directory holding the `*.json` sync files. |
| `dry-run` | `false` | Log the planned writes without calling the write API. |
| `update-stories` | `true` | After assets change, repair asset references in existing prod stories not in this sync set. |
| `prune-presets` | `true` | Delete stale presets of a synced component that no longer exist in dev. |
| `fail-on-partial` | `true` | Exit non-zero when some (but not all) items fail. |
| `debug` | `false` | Force-visible debug logging incl. every MAPI call. Also auto-on under GitHub step-debug (`ACTIONS_STEP_DEBUG`). |
| `clear-processed-files` | `false` | Delete each sync file whose items all succeeded from the working tree. |

### Outputs

| Output | Description |
|--------|-------------|
| `components-synced` | Components created or updated. |
| `assets-synced` | Assets created or updated. |
| `stories-synced` | Stories created or updated. |
| `summary` | One-line run summary. |
| `cleared-files` | Comma-separated sync files the action deleted (for the workflow to commit). |

## Caveats

- **Cross-space story links** rely on a slug bridge (no persisted uuid
  manifest). A link to a story that doesn't exist in prod and isn't in the sync
  set can't be remapped — the action **warns** and leaves it pointing at the dev
  id. Include linked stories in the sync file.
- **Asset matching by `short_filename`** is ambiguous when prod has duplicate
  filenames; the action matches the first and warns on multiples.
- **Runtime** scales with story/asset counts at the SDK's ~6 req/s throttle. Set
  a generous job timeout for large syncs.

## Development

TypeScript, tested with `vitest`, bundled to `dist/` with `@vercel/ncc`. The
bundle is committed and CI verifies it is in sync.

```bash
npm ci
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # ncc → dist/
```

Most logic is split into **pure functions** (ref-mapper, validation, link
bridge, dependency closure/graph/remap, sync-file, pagination, progress) and
thin **injected-client orchestrators** (components/assets/stories push), so it is
almost entirely unit-testable; a couple of HTTP-level tests exercise the real
SDK through undici's `MockAgent`.
