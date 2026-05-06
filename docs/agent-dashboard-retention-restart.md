# Per-Workspace Agent Activity: Preserve Across Restart

## Goal

When a user has the experimental agent dashboard toggle on (`settings.experimentalAgentDashboard === true`), the per-workspace agent activity they see on each worktree card should survive an Orca app restart.

The user-visible problem is broader than "done rows vanish": any agent whose status was visible before quit and which does not re-emit a hook event on its own — `done` agents (process gone, no future event), `blocked` Claudes (idle at a permission prompt, no event until the user acts), and `working` agents that happen to be quiet at quit time — disappears from the dashboard until something happens to make them speak again. The most-cited symptom is `done` rows winking out, but the same restart-erasure hits `blocked` and quiet `working` for exactly the same reason: nothing replays the last-known status across the boundary.

Persisting the hook server's existing per-pane status cache fixes all three at once. The renderer pulls a main-process snapshot after settings and workspace tabs are hydrated, so startup delivery no longer depends on early IPC timing; dismissals still flow back to main through `agentStatus:drop`.

## Scope

In scope:

- Persist `lastStatusByPaneKey` (the module-level `Map` in `src/main/agent-hooks/server.ts:65` that already caches the latest hook payload per `paneKey`) to a JSON file under `userData/agent-hooks/`. Hydrate it on `start()` before the HTTP server begins accepting requests.
- Mirror cache mutations to disk through a debounced trailing write so a burst of hook events does not produce N file writes. Force a synchronous final flush on `stop()` so quit-time state is captured.
- Update the on-disk file when `clearPaneState(paneKey)` is called from PTY teardown (`src/main/ipc/pty.ts:349`), so a pane that closes during a session does not resurrect on the next launch.
- Gate disk _writes_ on `experimentalAgentDashboard === true` so users who have not opted in do not accumulate on-disk hook payloads. Skip hydration when the flag is off at launch.

Out of scope:

- Renderer-side persistence (`retainedAgentsByPaneKey`, `acknowledgedAgentsByPaneKey`, `retentionSuppressedPaneKeys`). The renderer's retention slice and `useRetainedAgentsSync` continue to operate purely in memory; their "stay until dismissed" contract is upheld by the live entry being pulled from the main-process status snapshot after renderer hydration.
- Daemon-side persistence. The daemon owns PTY lifetime and scrollback, not hook events. The hook server (in the Electron main process) is the right home.
- Cross-device sync. The on-disk file lives in `userData`; running Orca on a second machine does not carry retained activity.
- Changing the experimental gate itself. The gate stays; this proposal makes the feature behave correctly when it is on.
- A staleness TTL or visible "completed N days ago" indicator. The `done`-only retention case where staleness was sharpest in the prior renderer-side draft is unchanged here (`done` rows still auto-evict on dismiss; users who quit mid-task and return next morning see what they saw last). If long-tail staleness becomes a real complaint, a TTL on hydration is a small follow-up — see Follow-ups.

## Background

### How agent status flows from hook → renderer today

The Electron main process runs a loopback HTTP server (`AgentHookServer` in `src/main/agent-hooks/server.ts`) that receives `POST /hook/<agent>` from Claude/Codex/Gemini/OpenCode/Cursor hook scripts and from the OpenCode plugin. On every successful POST it does two things (server.ts:1177-1181):

1. `lastStatusByPaneKey.set(paneKey, payload)` — caches the latest normalized payload per pane (server.ts:65).
2. `this.onAgentStatus?.(payload)` — fires the registered listener.

`src/main/index.ts:277-305` registers the listener on window creation. The listener forwards the payload to the renderer via `webContents.send('agentStatus:set', …)`, gated on `experimentalAgentDashboard === true` (index.ts:285). The renderer's `agentStatusByPaneKey` slice receives the IPC and writes the entry. From there, `useRetainedAgentsSync` produces `retainedAgentsByPaneKey` (sticky `done` snapshots), and the rest of the dashboard reads from those two maps.

The cache exists for a reason that already overlaps with this proposal: hook events arrive while Orca is windowless (common on macOS when the user closes the window but leaves the app running), so re-registering the listener replays everything cached so far. Disk hydration writes into the same map. The renderer now also has a pull-based `agentStatus:getSnapshot` path, which lets startup restore wait until renderer settings and workspace tabs are ready instead of relying on early replay timing.

### What survives restart today, indirectly

The persistent-terminal daemon survives Orca quit (it is spawned `detached`, see `src/main/daemon/daemon-init.ts:115-116`, and the IPC channel is disconnected, not killed, on quit). PTYs stay alive. The renderer reconnects to the daemon on launch and replays scrollback. Hook stdout from agents that _do something post-launch_ repopulates `agentStatusByPaneKey` naturally — but the hook server is fresh because:

- `agentHookServer.stop()` runs at `src/main/index.ts:624` during `will-quit`, clearing `lastStatusByPaneKey` (server.ts:1248).
- `agentHookServer.start()` runs at `src/main/index.ts:560` during the next launch with a brand-new `Map`.

So on relaunch the cache is empty, and any pane whose agent does not emit a fresh hook event is invisible:

- `done` agents (process is gone — no future event possible).
- `blocked` Claudes (idle waiting on permission prompt — no event until the user acts).
- Quiet `working` agents (active but mid-step, not currently emitting).

Persisting the cache fixes all three. Live agents that _do_ emit an event post-launch overwrite the hydrated entry through the same `lastStatusByPaneKey.set` path that updates them today (server.ts:1179) — no special collision handling needed.

## Proposed Shape

Persist `lastStatusByPaneKey` to a JSON file alongside the existing endpoint coordinate file under `userData/agent-hooks/`. The hook server already takes `userDataPath` in `start()` (server.ts:1119, called from `src/main/index.ts:560-567`) and already manages `userData/agent-hooks/` for the endpoint file.

Filename: `last-status.json`. Same directory permissions as the endpoint file (0o700 on the dir, 0o600 on the file — see server.ts:1349, 1395) so the cached payloads are not readable by other local users on multi-user POSIX hosts.

On-disk shape:

```jsonc
{
  // Why: a tiny version field is cheap insurance against future reshapes
  // (e.g. trimming oversized lastAssistantMessage, dropping stateHistory).
  // Mismatched versions are silently dropped on hydrate — no migration code.
  "version": 2,
  // Why: paneKey is `${tabId}:${paneId}`; mirrors the in-memory Map shape
  // exactly so hydrate is a single Object.entries → map.set loop.
  "entries": {
    "tab-abc:pane-1": {
      "paneKey": "tab-abc:pane-1",
      "tabId": "tab-abc",
      "worktreeId": "wt-…",
      "receivedAt": 1710000000000,
      "stateStartedAt": 1710000000000,
      "payload": {
        /* ParsedAgentStatusPayload */
      }
    }
  }
}
```

The shape is the structural mirror of the existing `AgentHookEventPayload` type (server.ts:44-49), wrapped in a `{ version, entries }` envelope. The timing fields preserve the real age of restored rows so relaunch does not make old statuses look fresh. The payload is parsed on hydrate by the existing `parseAgentStatusPayload` / `normalizeAgentStatusPayload` from `src/shared/agent-status-types.ts:259, 268`, which already enforces the schema invariants the renderer assumes.

Why this file and not `PersistedUIState` (the prior renderer-side draft):

- `PersistedUIState` holds scalar UI prefs (widths, sort orders, dismiss flags). The hook payload is structured event data — `AgentStatusEntry` carries `stateHistory[]`, `toolInput`, and `lastAssistantMessage`, any of which can be multi-KB. Bloating the prefs file with churning event data is a category mistake.
- `userData/agent-hooks/` already exists as the home for hook-server on-disk coordination state (the endpoint file). Adding a cache file there keeps "hook-server-owned, survives-restart artifacts" co-located.
- The renderer is downstream of `lastStatusByPaneKey`; persisting upstream lets the renderer's retention slice and `useRetainedAgentsSync` operate unchanged off the live map. The renderer change is a small snapshot pull in `useIpcEvents.ts` after settings and `workspaceSessionReady` are true, plus timing propagation into `setAgentStatus`. Persisting downstream would fork persistence across processes and only solve the `done` slice of the user complaint.

Why a `Record<paneKey, entry>` (and not an array): matches the in-memory `Map` shape, so the read and write paths are one-line transforms.

Why no field-level cap on payload size: the same payloads are already accepted into memory unbounded by the running hook server. If memory pressure ever forces a cap, it should be applied at the cache write site (server.ts:1179) and inherited by both the in-memory and on-disk path. Capping only on disk would diverge the two and surprise anyone reading the cache directly.

## Write Rules

`lastStatusByPaneKey` (the in-memory map) is the source of truth. Persistence is a write-through mirror that hooks into the three existing mutation sites in `src/main/agent-hooks/server.ts`:

| Site                                                                     | What changes                      | Persistence action                                        |
| ------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------- |
| `lastStatusByPaneKey.set(...)` at HTTP handler (server.ts:1179)          | New or updated payload for a pane | Schedule debounced write                                  |
| `lastStatusByPaneKey.delete(...)` in `clearPaneState()` (server.ts:1262) | PTY for the pane has torn down    | Schedule debounced write                                  |
| `lastStatusByPaneKey.clear()` in `stop()` (server.ts:1248)               | Server is shutting down           | Schedule write, then synchronously flush before returning |

A single helper inside the class — `private scheduleStatusPersist()` — sets a 250 ms trailing timer, captured per-instance. Each scheduled write reads the current `lastStatusByPaneKey` and the current `experimentalAgentDashboard` setting, then:

- If the gate is on, writes `{ version: 2, entries: {…} }` to `last-status.json` (atomic via tmp + rename — same pattern as `writeEndpointFile()` at server.ts:1310).
- If the gate is off, the write is a no-op for users who never opted in (the file does not exist; do not create one). For users who previously opted in, the write deletes the existing file once (one filesystem op, idempotent on subsequent attempts) and stops scheduling further writes until the gate flips back on. Deletion is preferred to "write empty" so a flag-off user never has hook-payload data on disk after the next sync.

A `flushStatusPersistSync()` method runs the pending write synchronously. `stop()` calls it before clearing the map so quit-time state is captured even if a debounced write was pending. `will-quit` already has the synchronous order it needs (`agentHookServer.stop()` at index.ts:624 runs before `app.quit()` resolves), so the synchronous flush slots in cleanly.

Specifics:

- Gate writes on `experimentalAgentDashboard === true`. Read the setting at write time via the same `store?.getSettings()` accessor `src/main/index.ts:285` already uses for the IPC forwarding gate. Importing the store handle into the hook server is the cleanest seam; the alternative (passing the gate as a callback into `start()`) works too and keeps the server class agnostic of the store. Pick whichever is closer to the existing dependency direction in the file at implementation time. (Today, the server class has zero direct references to the renderer-side store; pushing a `getSettings`-style callback through `start()` preserves that and is the recommended path.)
- Debounce 250 ms trailing. A burst of hook events from a multi-agent run otherwise produces a write per event. The existing PTY-data path uses similar trailing batching for renderer IPC, so the latency budget is consistent.
- When the gate flips from on → off, delete the existing `last-status.json` once (no-op if it does not exist) and skip subsequent writes until the flag flips back on. Use deletion rather than "write empty" so a flag-off user has no hook-payload data on disk afterwards. The in-memory cache stays populated — the gate only controls IPC forwarding to the renderer (index.ts:285) and disk persistence. Cursor-agent's title-driving at index.ts:302-304 operates on the live event payload (not on `lastStatusByPaneKey.get(...)`), so leaving the cache populated is not strictly required for cursor; we leave it because (a) the cache is already populated by every hook event regardless of gate state and pruning it adds complexity for no gain, and (b) flipping the gate back on later should resume from the same state without re-collecting events.
- When the gate flips from off → on, do not eagerly write. The next `set`/`delete` will pick up persistence naturally on its scheduled trigger, and any payload already in the in-memory cache will be persisted on the first write after the flip.
- Identity check before write: if the JSON-stringified payload is byte-identical to the last persisted payload (cached on the instance as `lastWrittenJson`), skip the write. Cheap protection against re-firing trailing timers when nothing actually changed.

`clearPaneState(paneKey)` (called from `src/main/ipc/pty.ts:349` on PTY teardown) already handles the within-session "pane is gone" case by deleting from the in-memory map. Mirroring it to disk through the same scheduled write means a pane closed in the previous session is absent from the on-disk file the next time it's read, so hydration cannot resurrect it.

### Dismiss propagation

Today, when a user clicks the X on a retained row, `WorktreeCardAgents.tsx` calls `dropAgentStatus(paneKey)` and `dismissRetainedAgent(paneKey)` (`src/renderer/src/store/slices/agent-status.ts:316, 537`). Both are pure-renderer mutations — they do not touch the hook server. Without persistence, this works because the next launch starts with an empty cache anyway.

With persistence, the dismissed paneKey is still in `lastStatusByPaneKey` and would be re-hydrated on the next launch, defeating the dismiss. We close this gap by adding a small IPC: when `dropAgentStatus(paneKey)` runs in the renderer, it also fires `window.api.agentStatus.drop(paneKey)`, which lands in the main process and calls `agentHookServer.clearPaneState(paneKey)`. The same scheduled write helper that handles PTY teardown then evicts the entry from disk on the next debounce tick.

This means:

- IPC channel: a new `agentStatus:drop` request (renderer → main). Single argument: `paneKey: string`. Fire-and-forget; no response needed.
- Renderer wiring: extend `dropAgentStatus` in `agent-status.ts:316` to invoke the IPC at the end of its zustand `set(...)` block. The existing intra-renderer behavior is unchanged; the IPC is a write-through mirror, exactly like the disk persistence side of the hook server.
- Main wiring: add a tiny IPC handler in `src/main/index.ts` (or a dedicated handler file) that calls `agentHookServer.clearPaneState(paneKey)`. Keep it gated on the same `experimentalAgentDashboard === true` check used elsewhere in main — even though `clearPaneState` is itself idempotent, the gate prevents a non-opted-in user's renderer (which still calls `dropAgentStatus` for non-dashboard reasons like cursor-agent OSC fallback) from churning the hook server's persistence path.
- `dismissRetainedAgent` does not need its own IPC — `dropAgentStatus` covers the "remove this paneKey from everything" intent, and the dismiss-from-retained-only case is rare enough (and benign enough) to ride on the same path. If we later separate the two, add `agentStatus:drop` symmetry then.
- `dismissRetainedAgentsByWorktree` (`agent-status.ts:578`, the worktree-scoped bulk dismissal action) DOES need to propagate. Currently no production code path calls it — the live worktree-archive flow goes through `dropAgentStatusByTabPrefix` per-tab and PTY teardown then propagates `clearPaneState` (see below). We add the fan-out defensively so a future caller cannot reintroduce a disk leak. Wiring: in the slice action's set callback, collect the paneKeys being removed, then after the set completes, fire one `window.api.agentStatus.drop(paneKey)` per key. The IPC surface stays at a single channel; only the call count fans out. We do NOT add a separate `agentStatus:dropByWorktree` IPC because per-paneKey overhead is not a concern at the call rates this action would be invoked, and a single channel keeps the main-process handler shape simple.
- `dropAgentStatusByTabPrefix` (`agent-status.ts:423`, called from `terminals.ts:550` on tab close and `terminals.ts:1080` on worktree shutdown/sleep) does NOT need IPC fan-out. Every caller subsequently kills the affected PTYs via `window.api.pty.kill(...)`, and the existing main-process PTY-onExit chain calls `clearProviderPtyState` → `agentHookServer.clearPaneState(paneKey)` (`src/main/ipc/pty.ts:349`), which evicts the persisted entry through the same scheduled-write helper that handles every other eviction. The disk follows naturally.

The `agentStatus:drop` channel is the only IPC surface change introduced by this design.

## Hydration Rules

Hydration runs inside `start()` after the userDataPath is set up but before `server.listen()` is called (server.ts:1221) — so the in-memory map is fully populated before the first hook POST can arrive. The renderer reads that hydrated map through `agentStatus:getSnapshot` after settings and workspace tabs are ready.

Order of operations on launch:

1. `agentHookServer.start({ userDataPath })` is called from `src/main/index.ts:560` before window creation.
2. Inside `start()`, before binding the HTTP server: read `userData/agent-hooks/last-status.json`, parse, sanitize, and `lastStatusByPaneKey.set(...)` each surviving entry. Failure modes (missing file, parse error, schema mismatch) all degrade gracefully — log once, leave the in-memory map empty.
3. The HTTP server binds and starts accepting POSTs. New hook events go through the same `lastStatusByPaneKey.set` write site (server.ts:1179), overwriting hydrated entries naturally.
4. Window creation registers the renderer listener via `setListener()` (index.ts:277). Live pushes remain best-effort, but the startup restore no longer depends on these early sends being accepted by the renderer.
5. `useIpcEvents.ts` waits until `settings.experimentalAgentDashboard === true` and `workspaceSessionReady === true`, then invokes `window.api.agentStatus.getSnapshot()` and applies each surviving entry through `setAgentStatus(...)`.

Gate hydration on `experimentalAgentDashboard === true` at launch. When the flag is off, skip reading the file (the IPC forwarding gate at index.ts:285 already drops anything that arrives anyway, and we want to avoid loading event payloads into memory the user has not opted into). The next persistence pass deletes any existing file so a flag-off user does not keep hook payloads on disk.

Sanitization is field-by-field rather than whole-entry rejection so a single bad pane cannot tank the whole hydration:

- Top-level: must be `{ version, entries }` with `version === 2` and `entries` an object. Anything else → empty hydration, single console warn.
- For each `[paneKey, entry]` pair:
  - `paneKey` must be a string matching `${tabId}:${paneId}` shape (non-empty `tabId` segment, non-empty `paneId` segment, exactly one `:`). Drop on mismatch.
  - `entry.paneKey` must equal the map key. Drop on mismatch — the key is the trusted form, but a divergence indicates corruption.
  - `entry.payload` must round-trip through `normalizeAgentStatusPayload` (`src/shared/agent-status-types.ts:259`) — this is the same validator the HTTP handler uses on every live POST, so the on-disk path inherits the same schema invariants without duplicating rules.
  - `entry.tabId` and `entry.worktreeId` must be either undefined or non-empty strings. Drop entries with empty-string values for these (they are typed optional but should never appear blank in practice).
  - `entry.receivedAt` and `entry.stateStartedAt` must be positive finite numbers. Drop on mismatch so restored rows keep their real age instead of being restamped.

Note what we do _not_ sanitize against: current worktrees, tab IDs, or daemon PTY liveness. Those checks belong downstream:

- The renderer already prunes `retainedAgentsByPaneKey` against current worktrees in `useRetainedAgentsSync` (`pruneRetainedAgents(existingWorktreeIds)`). Snapshot entries that map to dead worktrees or unknown tabs are dropped by the same per-tab resolution path used for live pushes.
- Daemon PTY liveness is not the hook server's knowledge. Adding a cross-process check here would couple the server to the daemon and slow down `start()`. The brief render of a "ghost" status that disappears on first sync is acceptable — strictly better than dropping live `blocked`/`working` entries because of a transient mismatch, and equivalent in practice for `done` entries (which are about something that already happened).

Hydration timing relative to window creation:

- The hook server starts before the window (`src/main/index.ts:560` vs. `src/main/index.ts:577`). Hydration is therefore complete before any renderer code can register a listener.
- `setListener()` is registered synchronously inside `openMainWindow()` (`src/main/index.ts:277`) and may replay before the renderer bundle has loaded or before `tabsByWorktree` is hydrated.
- The renderer treats those early pushes as disposable: if settings or workspace state is not ready, `useIpcEvents.ts` ignores the push. Once both are ready, it pulls the authoritative snapshot from main and applies entries whose paneKeys still resolve to live tabs.

To make hydration visible after launch, we add **one small renderer change** plus a deferred snapshot trigger:

1. **Renderer snapshot pull.** Modify `useIpcEvents.ts` so live `agentStatus:set` pushes are applied only when the dashboard is enabled and `workspaceSessionReady` is true. Register a store subscription in the same effect; once those conditions are true, call `window.api.agentStatus.getSnapshot()`, re-resolve each paneKey, drop entries whose tab is still unknown, and call `setAgentStatus(...)` for the rest.

2. **Snapshot timing.** Include `receivedAt` and `stateStartedAt` in both the persisted file and the IPC payload. `setAgentStatus` accepts those timestamps so restored rows retain their actual age, and it ignores an older snapshot entry if a newer live push already landed for the same pane.

This keeps `setListener()`'s synchronous replay semantics for windowless app sessions while making restart restore independent of renderer boot order. Rationale for using a snapshot instead of a renderer queue:

- Deferring `setListener` until `webContents.did-finish-load` adds an `app/main` ↔ `renderer` handshake (a "renderer-ready" IPC ping) plus changes the lifetime guarantees of the existing windowless-replay path that the comment at `src/main/index.ts:260-264` already depends on.
- A renderer-side queue still depends on early IPC delivery and requires a bounded buffer policy. The main process already owns the durable map, so a snapshot is simpler and cannot lose entries before the renderer knows settings or tabs.

The renderer slice's persistence model is otherwise unchanged, and `useRetainedAgentsSync` continues to operate purely in memory off the live map.

## Edge Cases

**Live agent re-emits a hook event for a hydrated paneKey.** The HTTP handler's `lastStatusByPaneKey.set(payload.paneKey, payload)` (server.ts:1179) overwrites the hydrated entry. The renderer receives a fresh `agentStatus:set` IPC, replacing the hydrated state in `agentStatusByPaneKey`. No collision logic is needed — the live event is unconditionally newer.

**Reused paneKey with a fresh agent run after restart.** A newly spawned agent on the same paneKey emits `working` (or whatever its first hook event is). That event runs through the normal write path and overwrites the hydrated entry the same way an in-session reuse does today. The renderer's `useRetainedAgentsSync` continues to do its diff against `agentStatusByPaneKey`; if the previous `done` was retained from the hydrated state, the new live entry knocks it out on the next sync.

**PTY died between sessions (race window: pane closed during the previous Orca's quit, after the final write).** The hydrated cache contains an entry for a pane whose tab no longer exists. The renderer's existing per-tab filter on `agentStatusByPaneKey` (the dashboard reads only entries whose `tabId` is in the current `tabsByWorktree` for the worktree it's rendering) silently hides the orphan. Acceptable: at most one momentary stale row that never visually appears, and only on the narrow window where `clearPaneState` did not run before quit.

**Worktree archived between sessions.** Hydration does not check worktree liveness. The renderer's existing `pruneRetainedAgents(existingWorktreeIds)` (and the dashboard's worktree-scoped reads) ensures the entry never reaches the rendered inline list. Same outcome as the tab-closed case.

**On-disk corruption.** Sanitize field-by-field; never throw. A corrupt file yields an empty hydration result with a single console warn. The dashboard renders normally — the new behavior matches today's "no persistence at all" baseline, so any corruption mode is strictly no-worse than current state.

**Stale file from a prior Orca version with a different schema.** The `version: 2` envelope rejects mismatches at parse time. An older Orca that wrote `version: 1` (or no version field) is treated like a corrupt file → empty hydration. No migration code, no explosion.

**Dual instances of Orca pointing at the same `userData`.** Two processes race on `last-status.json`. Last write wins. The existing endpoint file at the same path has the same property (server.ts:1232-1240 explicitly accepts last-write-wins for the endpoint file). Hook payloads are a UX surface, not a correctness-critical store, so the trade-off matches.

**Concurrent write while reading on launch.** The atomic-rename pattern (write to `.tmp`, `renameSync` into place — same as `writeEndpointFile()` at server.ts:1395-1397) means a reader at the moment of a write sees either the prior file or the new one, never a partially-written file. POSIX rename atomicity holds; on Windows, `renameSync` is also atomic for same-volume moves.

**SSH worktrees.** Hook payloads for panes whose worktree happens to be SSH-mounted are persisted exactly like local panes — the hook server only sees the paneKey and the payload, not the worktree's transport. If the SSH connection drops post-restart, the hydrated entry remains visible until the renderer's existing tab/worktree filters take it out. Same behavior as in-session today.

**Settings flag flipped off after a session populated the file, then quit.** The flag flip itself triggered a one-shot delete of `last-status.json` (see Write Rules). The next launch with the gate off skips hydration regardless. Flipping the flag back on later starts from no on-disk state; the dashboard is empty until the next hook event repopulates the cache and the next scheduled write rewrites the file.

**Settings flag flipped off mid-session.** The next debounced write deletes `last-status.json` (idempotent) and subsequent writes are skipped while the flag stays off. The in-memory cache is _not_ cleared so a later flip back on resumes from the same state.

## Implementation Notes

Primary file:

- `src/main/agent-hooks/server.ts` — all changes land here:
  - Add a private `lastStatusFilePath: string | null` set in `start()` from `userDataPath`.
  - Add a private `getDashboardEnabled: (() => boolean) | null` callback set from `start({ getDashboardEnabled })`. The hook server stays decoupled from the store — `index.ts` passes a closure that reads `store?.getSettings().experimentalAgentDashboard === true`.
  - Add `private hydrateLastStatusFromDisk()` invoked at the top of `start()` (gated on `getDashboardEnabled?.() === true`). Reads file, `JSON.parse`s the envelope, sanitizes field-by-field, validates each `entry.payload` via `normalizeAgentStatusPayload` (`src/shared/agent-status-types.ts:259` — accepts `unknown`, returns parsed `ParsedAgentStatusPayload | null`), and calls `lastStatusByPaneKey.set(...)` for survivors. Use `normalizeAgentStatusPayload`, not `parseAgentStatusPayload` — the latter takes a JSON string only and would force a wasteful stringify/parse round-trip.
  - Add `private scheduleStatusPersist()` and `private flushStatusPersistSync()`. Wire them into the three mutation sites: HTTP handler `set` (server.ts:1179), `clearPaneState` `delete` (server.ts:1262), and `stop()` `clear` (server.ts:1248). The `stop()` path uses the synchronous flush before `lastStatusByPaneKey.clear()`.
  - Add atomic write helper that mirrors the existing `writeEndpointFile()` pattern (tmp + rename, 0o600 mode, owner-only directory at 0o700 — server.ts:1349, 1395). Tmp filename: `.last-status-<pid>-<uuid>.tmp` (distinct prefix so a future filename change to one writer does not affect the other). Extend the existing orphan-tmp sweep at server.ts:1372 to match either prefix (`.endpoint-` OR `.last-status-`) so a crash mid-write of either file is cleaned up by either subsequent start.
  - Add `getStatusSnapshot()` so the renderer can pull the current hydrated map after its own settings/session state is ready. `setListener()` remains unchanged for the existing windowless-window recreation path.

- `src/main/index.ts` — pass `getDashboardEnabled` to `agentHookServer.start({...})` at index.ts:560-567. Forward live `agentStatus:set` payloads with `receivedAt` and `stateStartedAt`. Existing `setListener` registration at index.ts:277 remains unchanged.

- `src/main/ipc/agent-hooks.ts` — add `agentStatus:getSnapshot`, gated on `experimentalAgentDashboard === true`, returning `agentHookServer.getStatusSnapshot()`. The existing `agentStatus:drop` handler continues to call `agentHookServer.clearPaneState(paneKey)`.

- `src/renderer/src/hooks/useIpcEvents.ts` — make the `agentStatus.onSet` handler require both the dashboard gate and `workspaceSessionReady`. Add a store subscription that calls `window.api.agentStatus.getSnapshot()` once when those conditions become true, re-resolves each paneKey, drops unknown-tab entries, and applies the rest through `setAgentStatus` with timing metadata.

- `src/renderer/src/store/slices/agent-status.ts` — extend `setAgentStatus` to accept optional `{ updatedAt, stateStartedAt }` timing. Use those values for snapshot hydration, and ignore stale snapshot entries if a newer live push is already present.

- `src/preload/index.ts` and `src/preload/api-types.ts` — expose `agentStatus.getSnapshot(): Promise<AgentStatusIpcPayload[]>`, keep `agentStatus.drop(paneKey: string): void`, and type `agentStatus.onSet` with the shared IPC payload.

Other renderer files (`src/renderer/src/components/dashboard/useRetainedAgents.ts`, `src/renderer/src/components/dashboard/useDashboardData.ts`, `src/renderer/src/App.tsx`): **no changes**. The retention slice and dashboard memos see the hydrated entries through the existing `setAgentStatus` path once the snapshot applies.

`src/shared/agent-status-types.ts` — add `AgentStatusIpcPayload`, which extends the parsed payload with pane identity and timing fields shared by main, preload, and renderer.

Tests:

- `src/main/agent-hooks/server.test.ts` — extend with:
  - Sanitization unit tests: bad version, missing entries, malformed paneKey, key/embedded paneKey mismatch, payload that fails `normalizeAgentStatusPayload`.
  - Persistence unit tests: a `set` schedules a write; the debounce coalesces two rapid `set`s into one write; identical-payload writes are skipped; `stop()` flushes synchronously; flipping the gate from on → off deletes the file (or no-ops if absent) and skips subsequent writes.
  - Hydration unit tests: starting with a populated file populates `lastStatusByPaneKey` before the HTTP listener binds; missing file is a no-op; corrupt file is a no-op + warn.
  - Snapshot test: after hydrate, `getStatusSnapshot()` returns the hydrated entries with timing metadata.
  - Gate test: with `getDashboardEnabled` returning false, `start()` skips hydration and `set` skips writes.
- Existing `useRetainedAgents.test.ts` runs unchanged.
- New renderer test in the existing agent-status slice test file: `dropAgentStatus` fires `window.api.agentStatus.drop(paneKey)` exactly once after its zustand mutation; double-drop on the same paneKey only fires once (idempotent).
- New IPC handler tests in the existing main-process test suite: `agentStatus:drop` with the gate on calls `clearPaneState`; with the gate off, the call is a no-op. `agentStatus:getSnapshot` returns cached entries with the gate on and an empty array with the gate off.
- New snapshot tests in `useIpcEvents.test.ts`: early `agentStatus:set` pushes before settings/session readiness are ignored, `getSnapshot()` is pulled once after readiness, entries whose tabs are still unknown are discarded, and no snapshot is requested while the dashboard gate is off.
- New worktree-archive IPC fan-out test on the slice: calling `dismissRetainedAgentsByWorktree(worktreeId)` fires `window.api.agentStatus.drop(paneKey)` once for each retained paneKey under that worktree.
- Integration sanity check (manual or in the dashboard suite): a `done` agent finishes → quit → file is written → relaunch → renderer's `agentStatusByPaneKey` is populated after settings/session hydration and snapshot pull → the inline list renders the row → dismiss → re-quit → relaunch → no row.

Telemetry:

- No new events. Hook server already runs unconditionally; we do not add observability for the persistence path beyond a single `console.warn` on file corruption (which would be silent today since corruption can't happen if the file does not exist).

Follow-ups (explicitly out of this design):

- Visible "completed N hours/days ago" indicator on hydrated rows. Today's UI shows the relative `updatedAt` which works inside a session and reads as "ages ago" cross-session. If users complain that a 3-day-old `done` row looks identical to a fresh one, the smallest fix is a tiny "completed at quit time" affordance, but that is a UX iteration on a renderer component and is not blocked by this design.
- TTL-on-hydrate (drop entries older than N days). Same rationale — easy to add inside `hydrateLastStatusFromDisk` if needed.
- Explicit cap on file size or per-pane count. The existing in-memory cache has no cap and we have not seen runaway growth in production; persisting the same shape inherits the same risk profile.

## Non-Goals

- Persisting `retainedAgentsByPaneKey`, `acknowledgedAgentsByPaneKey`, or `retentionSuppressedPaneKeys`. The renderer's retention slice is computed downstream from the live cache; the live cache is now persistent, so retention falls out for free.
- Daemon-side persistence. The daemon owns PTY lifetime and does not see hook events. The hook server (in the Electron main process) is the right home.
- Cross-device sync. The persisted file lives in local `userData/agent-hooks/`; running Orca on a second machine does not carry status over.
- A dedicated settings UI. The behavior is implicit when the experimental dashboard is on; no new toggle is added.
- Backfill or migration for users on prior builds. Absence of the file is the same as an empty cache.

## Why this beats the renderer-side alternative

An earlier draft of this design proposed mirroring `retainedAgentsByPaneKey` to `PersistedUIState`. We considered that approach and a variant that mirrored to `WorkspaceSessionState`. Both were rejected for three reasons:

1. **Wrong source of truth.** The hook server's `lastStatusByPaneKey` is upstream of every renderer-side surface. Persisting upstream means the existing in-process replay path (`setListener`) handles the renderer-facing work for free; persisting downstream forks responsibility across processes and only addresses the `done` slice of the user-visible problem.
2. **Wrong scope.** A renderer-side retention persister, by definition, cannot resurrect a `blocked` Claude or a quiet `working` agent — those entries never made it into `retainedAgentsByPaneKey` in the first place (retention is gated on `state === 'done'`). Persisting the upstream cache covers all three states with one mechanism.
3. **Wrong file.** `PersistedUIState` holds scalar prefs and small bounded metadata; structured event payloads with multi-KB `lastAssistantMessage` strings do not belong there. `WorkspaceSessionState` is closer in spirit but inherits problem (1) and (2) above. `userData/agent-hooks/` already exists for hook-server-owned cross-restart artifacts (the endpoint file); the cache file is the natural neighbor.

The renderer-side approach was strictly smaller code; the upstream approach is strictly more correct. The diff size for both is roughly the same once tests are factored in (one main-process file with bounded changes vs. one renderer slice + one shared type + one App.tsx init effect + sanitization), so we picked correctness.

## Acceptance Criteria

- **Done row preservation.** Toggle the experimental agent dashboard on. Run an agent to completion. Quit and relaunch Orca. The completion row appears in the worktree's inline agents list after renderer settings and workspace tabs hydrate and the snapshot pull completes.
- **Blocked row preservation.** Same flow, but quit while a Claude is sitting at a permission prompt (`blocked`). After relaunch, the blocked row is visible with the same prompt text and tool name.
- **Quiet working preservation.** Same flow, but quit while an agent is in `working` state and not currently emitting events. After relaunch, the row shows `working` with the last-known tool/prompt context. As soon as the agent emits its next event, the row updates naturally.
- **Live overwrite.** A hydrated row is overwritten when a new hook event fires for the same paneKey post-restart. No UI artifacts (no flicker, no double-rendered row, no orphan retention).
- **Reused paneKey, fresh run.** A `done` row is hydrated. The same paneKey starts a fresh agent run. The new live `working` row replaces the hydrated `done` immediately. On completion, the retention behavior matches in-session reuse — the new completion supersedes the hydrated one.
- **Dismiss is sticky across restart.** Dismiss the retained row from the inline list (X button). Quit and relaunch. The row does not reappear. See "Dismiss propagation" in Write Rules above for the IPC wiring this requires.
- **Worktree archive is sticky across restart.** Archive a worktree that has retained agents. Quit and relaunch. None of those rows reappear and `last-status.json` no longer contains them (verified by inspecting the file on disk).
- **Worktree archived between sessions.** A row is hydrated for a paneKey whose worktree was archived during the previous session. The row does not appear in the dashboard (the renderer's per-worktree filter hides it). No errors thrown.
- **Tab closed between sessions (race window).** A row is hydrated for a paneKey whose tab was closed in the gap between final write and quit. The row does not appear in the dashboard (the renderer's per-tab filter hides it).
- **Flag off the entire time.** With `experimentalAgentDashboard` off, the file is never written. `userData/agent-hooks/last-status.json` does not appear on disk. The hook server still runs (cursor-agent title-driving still works at index.ts:302-304).
- **Flag flipped off mid-session.** A populated cache exists in memory; the user toggles the flag off. The next scheduled write deletes `last-status.json` (idempotent if already absent) and subsequent scheduled writes are skipped. Memory state is unchanged.
- **Flag flipped off, then quit, then on.** With the flag off, the file was deleted by the gate-flip-off path (or never created if the user never opted in). Quit. Relaunch with the flag back on; the file is absent → hydration is a no-op → the dashboard starts clean. The first new hook event after launch will recreate the file from a fresh write.
- **Corrupt file.** Hand-edit `last-status.json` to invalid JSON. Relaunch. Single console warn, dashboard renders normally, no rows from the corrupt file. The first new event repopulates the file from a clean state.
- **Bounded renderer changes.** `src/renderer/src/components/dashboard/useRetainedAgents.ts`, `src/renderer/src/components/dashboard/useDashboardData.ts`, and `src/renderer/src/App.tsx` are not modified. Existing tests in `useRetainedAgents.test.ts` pass unchanged. The renderer change is limited to snapshot application in `useIpcEvents.ts` and timing-aware `setAgentStatus(...)` hydration.
