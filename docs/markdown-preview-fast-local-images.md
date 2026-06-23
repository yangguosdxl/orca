# Markdown Preview Fast Local Images

## Problem

Issue #6112 reports that images in Markdown preview are blank at first and only appear after a delay, even when the images are local.

- `src/renderer/src/components/editor/MarkdownPreview.tsx:1482` overrides rendered Markdown images and calls `useLocalImageSrc`.
- `src/renderer/src/components/editor/useLocalImageSrc.ts:173` returns `undefined` on cold cache, so the first paint emits an image without a usable `src`.
- `src/renderer/src/components/editor/useLocalImageSrc.ts:213` starts the local/runtime file read only from a React effect after paint.
- `src/renderer/src/components/editor/useLocalImageSrc.ts:214` starts an independent read per rendered image instance; repeated references to the same file can duplicate IPC/RPC work until the blob cache is populated.
- `src/renderer/src/runtime/runtime-file-client.ts:163` owns local fallback vs SSH/runtime preview routing when runtime context is present, so optimization must keep using that boundary and preserve the no-context `window.api.fs.readFile` fallback.

## Root Cause

Cold Markdown preview image loads are deferred until React effects run and then wait on IPC/RPC plus base64-to-blob conversion. The existing blob URL cache makes repeat previews fast after a successful load, but it does not share in-flight reads. Repeated references to the same image can race each other, create multiple blob URLs, and do duplicate local/SSH/runtime file reads before the cache is filled.

Prewarming can reduce late work and help images that have not mounted yet, but a normal `useEffect` in `MarkdownPreview.tsx` still runs after the same commit that mounts visible `MarkdownImg` components. Do not claim that prewarming makes the first cold image synchronous or eliminates the first blank paint for every unique image.

## Non-goals

- Do not render raw `file:` URLs or local absolute paths into `<img src>`.
- Do not add a new main-process protocol or bypass `readRuntimeFilePreview`.
- Do not change rendered Markdown parsing, link opening, image insertion, or export behavior.
- Do not introduce a visible loading skeleton or new Markdown preview controls.

## Design

1. Add an in-flight local image load map in `useLocalImageSrc.ts`.
   - Key by the existing `getLocalImageCacheKey`.
   - If a blob URL is cached, return it.
   - If a read is already pending for the key, return the same promise.
   - On success, create and cache one blob URL for the key; all joiners resolve to that URL.
   - On failure or non-binary/no-content preview data, clear the pending entry and return `null` without falling back to raw local paths.
   - Track `cacheGeneration` at read start. If focus invalidation happens before a pending read completes, do not cache or return the stale blob URL. Clearing the map alone is not enough because the original IPC/RPC promise still resolves.
   - When a pending promise settles, remove it from the map only if the map still points at that exact promise. An older completion must not delete a newer post-invalidation load for the same key.

2. Reuse the shared loader from both `loadLocalImageSrc` and `useLocalImageSrc`.
   - Keep the hook's initial state synchronous from `blobUrlCache`.
   - Add a lower-level absolute-path loader that owns cache lookup, in-flight dedupe, preview reads, generation checks, and blob creation. `loadLocalImageSrc` should only resolve raw Markdown src values and delegate to it.
   - In the hook effect, call the shared loader and update state only if still mounted and still on the effect generation that started the read.
   - Keep `generation` in the hook dependencies so focus invalidation cancels the old effect and starts a fresh read.
   - Preserve delayed blob revocation so currently rendered images keep displaying while replacements load.

3. Add Markdown preview prewarming.
   - Put extraction in a new focused module, not in `MarkdownPreview.tsx`; that file is already very large.
   - Parse Markdown with the existing `unified`/`remark-parse` stack plus the plugins needed to find the same mdast `image` and `imageReference` nodes rendered by preview (`remark-gfm` and `remark-frontmatter`). `remarkMarkdownDocLinks` only transforms text children and is not needed for image extraction. Do not use a regex scanner.
   - Resolve each image URL with `resolveImageAbsolutePath` and key with `getLocalImageCacheKey`. `resolveImageAbsolutePath` returns a filesystem path and drops URL query/fragment suffixes; that is acceptable for the image read and means `logo.png?v=1` and `logo.png?v=2` dedupe to the same file.
   - Prewarm only images that resolve to local filesystem paths. Leave `http:`, `https:`, `data:`, `blob:`, raw HTML `<img>`, and unsupported schemes to the mounted renderer path.
   - Dedupe by cache key, cap candidates below the 100-entry blob cache size, and bound concurrency. Starting 100 SSH/runtime preview RPCs at once is not free, and the cap should leave room for user-visible images loaded outside the prewarm queue.
   - A `MarkdownPreview.tsx` effect may fire-and-forget prewarming when `renderedContent`, `filePath`, or `imageRuntimeContext` changes. It must stop scheduling not-yet-started work after cleanup, but already-started IPC/RPC reads are only ignored via the loader generation guard.

4. Keep SSH/runtime behavior behind existing routing.
   - Prewarming calls the same shared loader with the same runtime context as visible images.
   - When runtime context is present, `readRuntimeFilePreview` decides local fallback vs runtime RPC through `getRemoteFileArgs`.
   - Remote-owned paths outside the worktree continue to fail through `readRuntimeFilePreview`; do not fall back to client-local `fs.readFile`.
   - When no runtime context exists, preserve the current `window.api.fs.readFile` path and optional SSH `connectionId` behavior.

## Data Flow

- Markdown preview receives file content.
- Prewarm effect parses rendered Markdown content, extracts resolved local image paths, and starts shared preview reads within the candidate/concurrency caps.
- `MarkdownImg` mounts and calls `useLocalImageSrc`.
- Hook returns a cached blob immediately, joins the in-flight read, or starts the same shared read.
- Shared loader reads through `readRuntimeFilePreview` or `window.api.fs.readFile`, converts binary preview data to a blob URL, and caches it only if the cache generation is still current.
- Mounted images update `src` to the blob URL; external URLs remain direct.

## Performance Impact

This should not add startup cost because it only runs when a Markdown preview is mounted or its rendered content/path/runtime context changes. The extra work is a parser pass over the already-rendered Markdown content plus capped, deduped local-image reads. The candidate cap and concurrency limit are required so large documents or SSH/runtime previews cannot flood IPC/RPC with image reads.

The expected steady-state effect is lower total work for repeated image references because mounted images and prewarming join the same in-flight read and reuse the same blob URL. The remaining cost is for unique cold images: disk or SSH/runtime IO, binary preview transport, base64-to-Blob conversion, and Blob memory within the existing preview-size/cache caps.

## Edge Cases

- Duplicate image references in one document must trigger one read per cache key.
- Re-render while a read is pending must not start a second read for the same key.
- Focus invalidation while a read is pending must prevent the old completion from caching or resolving a stale blob URL.
- A newer read after invalidation must not be overwritten or revoked by an older read that completes later.
- Unmount before read completion must not call `setState`.
- Non-binary, empty-content, oversized, missing, denied, unauthorized, or out-of-worktree remote image reads must leave the image unresolved and never expose raw paths. Local IPC previewable binaries are capped at 50 MB; runtime `files.readPreview` is capped at 10 MB.
- Window focus invalidation must clear cached blobs and pending reads so replaced files can reload, while delayed revocation preserves the old rendered image during the reload window.
- External image mutation while the owning window remains focused can still show the cached blob until the next focus invalidation or explicit reload. Do not expand scope into filesystem watching for this issue.
- Cache eviction must still revoke old blob URLs.
- Query/fragment suffixes must not break resolution, but they are not part of the file read cache key after URL-to-filesystem conversion. Percent escapes, Windows drive-letter paths, and UNC paths must keep resolving through existing path helpers.
- Remote/runtime context changes must produce distinct cache keys and not leak images across SSH/runtime owners.
- Large documents with many images must be capped and deduped to avoid renderer jank or excessive IPC/RPC volume.
- Reference-style images and images inside GFM tables should be found by the parser-based extractor. Raw HTML `<img>` prewarming is out of scope unless it can be done through the same sanitized/rendered pipeline; the mounted renderer path remains the correctness path for those.
- Blob URL caches are renderer-window local. Do not assume in-flight sharing or invalidation crosses Electron windows; each window must remain correct after its own focus invalidation.

## Test Plan

- Unit: `src/renderer/src/components/editor/useLocalImageSrc.test.ts`
  - repeated `loadLocalImageSrc` calls for the same image share one `readFile` and return the same blob URL; update the current concurrent-overwrite test accordingly;
  - failure clears the in-flight entry so a later retry can succeed;
  - cache invalidation drops cached and pending entries, and stale pending completions neither cache nor resolve blob URLs;
  - invalidation followed by a newer successful read cannot be overwritten by the older completion;
  - runtime owner cache scoping remains intact.
- Unit: `src/renderer/src/components/editor/markdown-preview-local-images.test.ts`
  - image extraction resolves relative paths, reference-style images, GFM table images, Windows absolute paths, UNC paths, and percent-escaped paths through `resolveImageAbsolutePath`;
  - query strings and fragments do not prevent resolution and are ignored for filesystem reads/dedupe;
  - external/data/blob URLs are skipped;
  - duplicate and over-limit images are deduped/capped;
  - prewarm uses the shared loader, does not enqueue more than the candidate cap, and never starts more than the concurrency limit.
- Unit: runtime routing
  - prewarm/loader calls `readRuntimeFilePreview` for runtime-owned worktree images;
  - runtime context with no active remote environment falls back to `window.api.fs.readFile` with the context connection id;
  - runtime-owned images outside the worktree reject without calling client-local `fs.readFile`;
  - the no-runtime-context path still calls `window.api.fs.readFile`.
- Interaction/unit: `MarkdownPreview` image rendering continues to route Cmd/Ctrl-click through the original Markdown target.
- Electron: open Markdown files with local images and verify images appear promptly on cold and repeat previews. If an SSH/runtime preview environment is available, include one remote-worktree image smoke; otherwise rely on the routing unit tests for SSH/runtime coverage.

## UI Quality Bar

User-visible timing change in the existing Markdown preview surface. The rendered preview must keep the current `markdown-preview.css` styling, image sizing, click behavior, scroll behavior, and dark/light appearance. No new colors, controls, copy, or layout wrappers should be introduced. Good enough means images appear without a prolonged blank first state, no broken-image icon for successful local images, no layout overlap, and no visible style drift from adjacent Markdown content.

## Review Screenshots

1. Cold Markdown preview of a local Markdown file with a relative local image visible in the document.
2. Repeat/warm open of the same preview showing the image immediately.
3. Markdown preview with a missing local image path showing the unchanged unresolved-image behavior without exposing raw filesystem paths.
4. Adjacent smoke: Markdown preview containing an external `https:` image or normal text/code content still renders with existing styling.
5. If SSH/runtime validation is available, capture the same relative-image case from a runtime-owned worktree; otherwise note the unit-test evidence in the PR.

## Rollout

1. Add shared in-flight/cached local image loader behavior and tests in `useLocalImageSrc.ts`.
2. Add local-image extraction/prewarm helper and tests.
3. Wire prewarming into `MarkdownPreview.tsx` using the existing runtime context.
4. Run focused tests, then `pnpm typecheck` and `pnpm lint`.
5. Validate the Markdown preview scenarios in Electron and capture required screenshots.

## Lightweight Eng Review

- Scope: reduced to renderer-side cache/in-flight/prewarm changes using existing file-preview APIs; no new main protocol, persistence, UI controls, or Markdown parser replacement.
- Architecture/data flow: `useLocalImageSrc.ts` remains the owner of local image blob caching and `readRuntimeFilePreview` remains the local/SSH/runtime boundary. `MarkdownPreview.tsx` only prewarms the same loader with its already-derived runtime context.
- Failure modes covered:
  - duplicate IPC/RPC reads before cache fill;
  - stale cached or pending images after external replacement;
  - stale pending completions racing newer reads;
  - failed, denied, non-binary, or remote-outside-worktree reads;
  - unmounted image components receiving async completion;
  - runtime/SSH ownership leaks via cache keys;
  - large Markdown files creating too many prewarm reads.
- Test coverage required:
  - `useLocalImageSrc.test.ts`: shared in-flight read, retry after failure, invalidation clears cache/pending, stale completion suppression, runtime cache key scoping;
  - image prewarm helper tests: parser-based extraction, path resolution, external URL skipping, dedupe, cap, concurrency;
  - runtime routing tests for `readRuntimeFilePreview` vs client-local `fs.readFile`;
  - existing Markdown preview link/image tests for click-routing regression;
  - Electron validation for cold, warm, missing-image, and adjacent external/content states.
- Performance/blast radius: no startup cost. Work is scoped to Markdown preview mounts and capped by count and concurrency. IPC/RPC volume should decrease for duplicate images and repeat renders; prewarm adds early reads only for Markdown image nodes that resolve to local filesystem paths. Large previewable images still cost disk/SSH/runtime IO, base64 transport, decode, and Blob memory, with current caps of 50 MB for local IPC reads and 10 MB for runtime `files.readPreview`.
- UI quality bar: validate the existing Markdown preview surface against `docs/STYLEGUIDE.md` and `src/renderer/src/assets/markdown-preview.css`; no new chrome, no style drift, no layout shift beyond normal image intrinsic sizing.
- Required review screenshots:
  1. Cold local-image preview.
  2. Warm/repeat local-image preview.
  3. Missing local-image preview.
  4. Adjacent external-image or normal Markdown content smoke.
  5. Runtime-owned worktree image if a runtime/SSH validation environment is available; otherwise cite the routing unit tests.
- Residual risks: the first unique cold image may still show a brief blank state while the authorized preview read and blob conversion complete. Externally replaced images can remain stale while the same window stays focused, and other Electron windows keep their own cached blobs until their own invalidation. This design reduces duplicate/late work but does not add filesystem watching, streaming, thumbnails, raw `file:` URLs, or cross-window shared caching.
