# Agent status indicators map to the wrong pane

## Problem

The inline AGENTS list in the worktree sidebar shows one row per running agent. Two affordances on that row depend on knowing which pane the agent is actually in:

1. **Auto‑ack** — when the user is "looking at" an agent's pane, the row's bold/unread badge clears so completed work doesn't keep nagging.
2. **Click‑to‑focus** — clicking the row activates the agent's tab and focuses the agent's pane.

When a tab has more than one pane (e.g. the user pressed Cmd+D inside a Claude tab to also have a plain shell next to it), both affordances misfire:

- Clicking the **blank** pane in the same tab silently auto‑acks the agent's row even though the user never looked at the agent's output.
- Clicking the **agent's status row** in the sidebar can land focus on the blank pane instead of the pane that's actually running the agent.

The user reported it as: *"When I clicked on a blank terminal pane it marked the agent status as read, and when I clicked on the actual agent status it brought me to that blank terminal pane instead of the actual one."*

## Root cause: pane identity is renumberable and exposed across boundaries

Agent status entries — and several adjacent maps (cache timers, retained snapshots, the `ORCA_PANE_KEY` env var seen by external CLI hooks) — are keyed by `paneKey = ${tabId}:${paneId}`, where `paneId` is the renderer‑local numeric id minted by `PaneManager.nextPaneId++` (`src/renderer/src/lib/pane-manager/pane-manager.ts:50,288`). That id has two properties that, taken together, are the bug:

1. **It renumbers on layout restore.** `replayTerminalLayout` (`src/renderer/src/components/terminal-pane/layout-serialization.ts:285`) constructs a fresh `PaneManager` whose `nextPaneId` starts at 1 again and walks the snapshot tree post‑order, allocating ids as it goes. The `pane:N` leafId strings in the snapshot are therefore re‑bound to whichever new numeric id replay happens to assign. PaneKeys minted **before** the restore embed the *old* numeric `paneId` and now point at ids the new manager either doesn't know about, or worse, has reassigned to a different leaf.
2. **It's exposed across boundaries that outlive the manager.** Renderer reload, app restart, and external hook scripts (`src/main/claude/hook-service.ts:78,117`, `src/main/cursor/hook-service.ts`, `src/main/gemini/hook-service.ts`, `src/main/codex/hook-service.ts`, `src/main/opencode/hook-service.ts`) all hold paneKey values that were minted earlier. The numeric id was an internal manager detail; treating it as a stable cross‑boundary identifier is the structural mistake.

### Why the two visible bugs follow

Both affordances ignore part of the identity in a way that makes the structural problem user‑visible.

**Auto‑ack uses tab as the unit of "viewed", not pane.** `computeAutoAckTargets` (`src/renderer/src/hooks/useAutoAckViewedAgent.ts:25`) walks every entry whose `paneKey` starts with `${activeTabId}:`:

```ts
const prefix = `${activeTabId}:`
for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
  if (!paneKey.startsWith(prefix)) {
    continue
  }
  // ...mark as ack candidate
}
```

For a tab whose layout is `split(pane:1 = Claude, pane:2 = blank)`, both `${tabId}:1` and `${tabId}:2` match the prefix. Whichever pane is actually focused, the effect acks every agent in the tab — including agents the user never visually attended to. The active *leaf* inside the tab is never consulted. This was a deliberate simplification when the dashboard was per‑tab, but inline agents are now per‑pane and the prefix walk hasn't been updated.

**Click‑to‑focus dispatches a numeric id that may be stale or aliased.** `handleActivateAgentTab` (`src/renderer/src/components/sidebar/WorktreeCardAgents.tsx:88`) parses the trailing integer out of `paneKey` and forwards it to `activateTabAndFocusPane(tabId, paneId)` (`src/renderer/src/lib/activate-tab-and-focus-pane.ts:4`), which dispatches a `FOCUS_TERMINAL_PANE_EVENT`. The receiver in `use-terminal-pane-global-effects.ts:118` does:

```ts
const pane = manager.getPanes().find((candidate) => candidate.id === detail.paneId)
if (!pane) {
  return
}
manager.setActivePane(pane.id, { focus: true })
```

After a layout restore that renumbered panes, the persisted numeric id either:

- **Misses entirely** — the manager has no pane with that id; the listener returns silently and focus stays on whichever leaf was last clicked (commonly the blank one, which is the user‑visible "wrong pane" symptom), or
- **Aliases to a different leaf** — the renumber happens to map the old `paneId` onto a *different* current pane. The listener's `find` succeeds and focuses the wrong pane without any signal that something went wrong.

Aliasing is the more dangerous case. The doc's own walkthrough flags it ("With three‑plus panes added in arbitrary order, the post‑replay `pane.id` for the leftmost leaf can differ from the snapshot's `pane:1`"), but a fallback‑on‑miss can't catch it because the lookup *succeeds* — just at the wrong leaf.

### Why the leafId convention isn't already the fix

The codebase already has a string convention for "which pane in this tab": `paneLeafId(paneId)` returns `pane:${paneId}` (`layout-serialization.ts:52`), and the layout snapshot persists `activeLeafId`, `ptyIdsByLeafId`, `buffersByLeafId`, and `titlesByLeafId` keyed by these strings (`src/shared/types.ts:356-368`). Switching `paneKey` to embed `paneLeafId(pane.id)` instead of `pane.id` looks like it would solve everything for free.

It doesn't. `paneLeafId` is a pure function of the renderer‑local numeric id (`return \`pane:${paneId}\``). The string `pane:5` post‑restore is a different leaf than `pane:5` pre‑restore *for exactly the same reason* the numeric `5` is a different leaf — the underlying numeric id was reassigned. The leafId convention is a useful shorthand for cross‑module references **within a session**, but it isn't a stable cross‑boundary identifier.

### Why a packaged build doesn't always show this

Both bugs reproduce regardless of build, but the click‑to‑focus path's restore‑renumber miss only matters across a renderer reload (Cmd+R, dev reload, app restart). The auto‑ack tab‑prefix bug fires on the very first paint of any split tab — it doesn't require a reload.

## Reproduction in this branch

The cross‑talk between dev instances on a shared `~/Library/Application Support/orca-dev/agent-hooks/endpoint.env` (described in passing during the original investigation) is **not** required to reproduce either bug. Repro by injecting the agent status directly so the test isolates the renderer logic from hook routing.

### Setup

1. From `brennanb2025/agent-panes-reporting`, run `node config/scripts/run-electron-vite-dev.mjs --remote-debugging-port=9334` and wait for the renderer URL.
2. In the running app, open a worktree (the bug repros in any worktree — `agent-status-demo` is convenient because it's clean).
3. Add a Claude tab via the New Tab `+` menu and let it boot (no prompt needed; the bug doesn't depend on the agent actually running).
4. Click into the Claude pane and press **Cmd+D** to split it. The tab is now `split(pane:1 = Claude, pane:2 = blank shell)` with `activeLeafId = pane:2`.

### Repro A — clicking a blank pane in a split tab marks the agent as read

In a DevTools console attached to the renderer (or via `playwright-cli eval`):

```js
const s = window.__store.getState()
const wtId = s.activeWorktreeId
const claudeTab = s.unifiedTabsByWorktree[wtId].find(t => t.label.includes('Claude'))
const paneKey = `${claudeTab.id}:1` // Claude pane

// Reset acks and inject a fresh "working" status on Claude's pane.
window.__store.setState((prev) => ({ ...prev, acknowledgedAgentsByPaneKey: {} }))
s.setAgentStatus(paneKey, { state: 'working', prompt: 'demo', interrupted: false }, '⠋ Claude Code')
```

Observation:

- The sidebar row appears with the unread/bold badge for ~1 frame, then `useAutoAckViewedAgent` sees `activeTabId === claudeTab.id` and acks `${claudeTab.id}:1` — the row drops to the muted state immediately.
- The active *leaf* is `pane:2` (the blank shell). The user is provably not looking at the agent's output, but the row is treated as viewed.

### Repro B — clicking a status row lands on the wrong pane after restore

This requires the renderer renumber in `replayTerminalLayout` to disagree with a stored paneKey:

1. With the split Claude tab from Setup, run an agent in `pane:2` so `agentStatusByPaneKey` has both `${claudeTab.id}:1` and `${claudeTab.id}:2`.
2. Force a renderer reload (Cmd+R or restart `pn dev`). The layout snapshot persists; retained agent snapshots survive via `retainedAgentsByPaneKey`.
3. After replay, the new manager allocates `pane.id` from 1 in post‑order over the snapshot tree. With three‑plus panes added in arbitrary order, the post‑replay `pane.id` for the leftmost leaf can differ from the snapshot's `pane:1`.
4. Click the agent's row in the sidebar. The listener's `getPanes().find(p => p.id === detail.paneId)` either finds nothing (silent return; focus stays on whichever pane was last clicked) or finds the wrong leaf (silent aliasing).

## Fix: stable pane identity (`stablePaneId`)

The proposed fix mints a stable per‑pane identifier at pane creation, persists it in the layout snapshot, and replaces the numeric `paneId` as the cross‑boundary identity. This eliminates both bugs at the root and removes the renumber/aliasing class from cache timers, retained snapshots, and the `ORCA_PANE_KEY` env var simultaneously.

### Approach considered and rejected

Two narrower fixes were considered and rejected:

- **Local patches (active‑leaf check + fallback in focus listener).** This treats the auto‑ack symptom correctly but only papers over click‑to‑focus by falling back to the active pane on miss. It cannot detect the silent‑aliasing case (lookup succeeds at the wrong leaf), and it leaves cache timers, retained snapshots, and `ORCA_PANE_KEY` drifting silently across reloads. The user‑reported symptom can persist post‑fix in restore‑renumber edge cases.
- **Reuse the existing `pane:N` leafId string as the cross‑boundary key.** Because `paneLeafId(paneId)` is derived from the renumberable numeric id, this is not actually stable across restores. It collapses into the proposed approach with a less‑opaque naming convention.

The proposed approach is the standard pattern when per‑pane identity has to cross boundaries that outlive the renderer: a UUID minted at creation, persisted in the layout snapshot, exported verbatim to child processes via env var, with display ordering computed from leaf order separately. A renderer‑local counter is only safe when that counter is **never** exposed across boundaries — extension/plugin APIs and external hook scripts must route persistent identity through a separate, opaque field. Our bug class is the predictable consequence of exposing the renderer‑local counter across boundaries.

### Identity model

Add a `stablePaneId: string` field to `ManagedPaneInternal`, allocated as `crypto.randomUUID()` in `createPaneInternal` (`src/renderer/src/lib/pane-manager/pane-manager.ts:287`). The numeric `id` stays as it is — it remains the renderer‑local handle for `getPanes()`, `setActivePane`, and event dispatches that originate from the manager. The new field is the **identity for cross‑boundary references**:

- `paneKey = ${tabId}:${stablePaneId}` everywhere paneKey is minted (`src/renderer/src/components/terminal-pane/pty-connection.ts:116` and any other producer)
- `ORCA_PANE_KEY` env var seen by external hooks contains the new format
- Persisted layout snapshot stores `stablePaneIdByLeafId` so replay can reattach the same UUID to the leaf it previously belonged to
- Sidebar agent rows store the full paneKey (already true) and dispatch `FOCUS_TERMINAL_PANE_EVENT` with `stablePaneId` instead of `paneId`

The numeric id keeps its narrow internal role; the UUID owns identity across reloads, hook scripts, and store snapshots.

### Renderer‑local numeric handle resolver

Some renderer code lives above any specific `TerminalPane` and therefore can't reach a `PaneManager` ref directly: IPC event handlers (`useIpcEvents`), status‑bar derivation (`mergeSnapshotAndSessions`), and the auto‑ack hook. These call sites need to translate `paneKey` (which carries the opaque `stablePaneId`) back to the renderer‑local numeric `paneId` for state that's keyed by it (e.g., `runtimePaneTitlesByTabId`).

Resolve via a small store‑backed mirror: `numericPaneIdByPaneKey: Record<string, number>`. PaneManager writes an entry on `createPaneInternal`/`adoptStablePaneId` (paneKey is `${tabId}:${stablePaneId}`) and removes it on pane close. Consumers do `numericPaneIdByPaneKey[paneKey]` instead of parsing. This keeps `runtimePaneTitlesByTabId` (and any other renderer‑live numeric‑keyed state) untouched while letting cross‑boundary paneKey lookups resolve correctly.

### Why: separating display id from identity

Two ids may seem like more complexity than needed, but conflating them is exactly what produced the bug. Numbering panes 1..N is useful for keyboard shortcuts and labels — derived from leaf order, not identity. Identity must be opaque and stable; UUID is the simplest construction that guarantees both. Once they're separated, neither can corrupt the other.

### Layout snapshot back‑compat

Existing layout snapshots in users' session storage do not contain `stablePaneIdByLeafId`. On replay, `replayTerminalLayout` (`layout-serialization.ts:285`) does:

1. If the snapshot includes `stablePaneIdByLeafId`, look up the UUID for each leaf and assign it to the freshly created pane via a new `PaneManager.adoptStablePaneId(numericId, stablePaneId)` method.
2. If absent (legacy snapshot or no snapshot at all), `createPaneInternal` mints a new UUID per pane as it would for a fresh layout.

Migration consequence: an upgrade across this change resets paneKey identity once. PaneKeys minted by the old build that survive in the renderer store (live `agentStatusByPaneKey` entries) lose their binding on first replay after upgrade. The user‑visible effect is one‑time: bold‑until‑viewed badges from before the upgrade clear when the upgraded renderer next acks the visible tab. No data is lost; agents continue to report into the new paneKey via the hook bus.

### Wire format change: `ORCA_PANE_KEY`

Hook scripts shipped in `src/main/claude/hook-service.ts:78,117`, `src/main/cursor/hook-service.ts`, `src/main/gemini/hook-service.ts`, `src/main/codex/hook-service.ts`, and `src/main/opencode/hook-service.ts` set `ORCA_PANE_KEY` and forward it to the `agent-hooks/server.ts` POST endpoint as an opaque string. They do not parse it. The format change from `${tabId}:${number}` to `${tabId}:${uuid}` is therefore safe across the shipped hooks.

User‑installed hook scripts that parse `ORCA_PANE_KEY` to extract the numeric pane id will break. There is no in‑process registry of these scripts. Mitigations:

- Document `ORCA_PANE_KEY` as opaque (already implicit — no schema is documented today).
- Length and shape of the new format are stable (`{tabId}:{uuid-v4}`); no surprises if the user's parser is "split on the last colon".
- Note in release notes that any hook script depending on the numeric‑id format must update.

This is a one‑time break, not a churning interface. Once stable, the contract holds for any future renumber/migration.

### Auto‑ack on the active *leaf*, not the active *tab*

`computeAutoAckTargets` should match `paneKey === ${activeTabId}:${activeLeafStablePaneId}` instead of just the tab prefix:

```ts
// useAutoAckViewedAgent.ts
export function computeAutoAckTargets(
  state: {
    agentStatusByPaneKey: Record<string, AgentStatusEntry>
    retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
    acknowledgedAgentsByPaneKey: Record<string, number>
  },
  activeTabId: string,
  activeLeafStablePaneId: string | null
): string[] {
  if (activeLeafStablePaneId === null) {
    return []
  }
  const targetKey = `${activeTabId}:${activeLeafStablePaneId}`
  const targets: string[] = []
  for (const map of [state.agentStatusByPaneKey, state.retainedAgentsByPaneKey]) {
    for (const [paneKey, value] of Object.entries(map)) {
      if (paneKey !== targetKey) {
        continue
      }
      const ackAt = state.acknowledgedAgentsByPaneKey[paneKey] ?? 0
      const startedAt =
        'entry' in value ? value.entry.stateStartedAt : value.stateStartedAt
      if (ackAt < startedAt) {
        targets.push(paneKey)
      }
    }
  }
  return targets
}
```

The active leaf's `stablePaneId` is read directly from the layout snapshot in the store: `useAppStore.getState().terminalLayoutsByTabId[activeTabId]?.stablePaneIdByLeafId?.[activeLeafId] ?? null`. No PaneManager reference is needed — the layout snapshot is the source of truth for both the active leaf and its stable id, and is the same place the hook already subscribes for the active‑tab/active‑view slices, so a focus change inside a split tab triggers the rescan.

The hook's reference‑equality short‑circuit (`useAutoAckViewedAgent.ts:108-114`) currently watches five slices. Add `terminalLayoutsByTabId` (or, narrower, the active tab's layout entry) to the watched set so a focus change inside a split tab — which mutates `activeLeafId` without touching the other five — re‑runs the scan. Without this, the equality fix would compute correctly but never re‑fire on the very state change it's supposed to detect.

This change matches the "the user actually saw this row" intent stated in the comment at `useAutoAckViewedAgent.ts:51`: a two‑pane tab where the user clicks back and forth between an agent pane and a blank pane will now ack only the pane they're currently in.

### Click‑to‑focus resolves by `stablePaneId`

`handleActivateAgentTab` (`WorktreeCardAgents.tsx:88`) splits paneKey at the tab boundary and forwards the suffix as `stablePaneId` instead of parsing an integer. The focus listener (`use-terminal-pane-global-effects.ts:108`) resolves through a `Map<stablePaneId, numericPaneId>` on the manager:

```ts
const onFocusPane = (event: Event): void => {
  const detail = (event as CustomEvent<FocusTerminalPaneDetail | undefined>).detail
  if (!detail?.tabId || detail.tabId !== tabId) {
    return
  }
  const manager = managerRef.current
  if (!manager) {
    return
  }
  const numericId = manager.getNumericIdForStable(detail.stablePaneId)
  if (numericId === null) {
    // Why: the carrying pane was closed or the snapshot's stablePaneId
    // wasn't restored (legacy snapshot path). The right behavior is to
    // surface that the agent's pane is gone, not to silently focus a
    // different leaf — that's how the previous bug presented.
    surfaceStaleAgentRow(detail.tabId, detail.stablePaneId)
    return
  }
  manager.setActivePane(numericId, { focus: true })
}
```

`surfaceStaleAgentRow` emits a non‑intrusive toast ("Agent's pane is no longer available") and dispatches an action that drops the row from `agentStatusByPaneKey` / `retainedAgentsByPaneKey` so the sidebar reflects reality. Dropping the row also clears `acknowledgedAgentsByPaneKey[paneKey]` and any retention‑suppression entries for that key — combined with the renderer's drop‑non‑UUID‑paneKey guard from the Migration section, a still‑running pre‑migration PTY's events are filtered before they can re‑create the row and re‑toast on each click. Because `stablePaneId` is opaque, "no match" unambiguously means the pane is gone — there is no aliasing case to disambiguate.

### Ack timing: defer until focus confirms

`handleActivateAgentTab` currently calls `acknowledgeAgents([paneKey])` *before* the focus dispatch (`WorktreeCardAgents.tsx:89`). With stable identity, the focus dispatch is reliable — but for safety and to keep the "user saw this row" semantic crisp, move the eager ack into a callback fired by the focus listener after `setActivePane` succeeds. If `surfaceStaleAgentRow` fired instead, no ack is recorded — the user didn't actually see the agent.

### What changes — file‑by‑file

- `src/renderer/src/lib/pane-manager/pane-manager.ts` — add `stablePaneId: string` to `ManagedPaneInternal`; mint via `crypto.randomUUID()` in `createPaneInternal`; expose `getStablePaneId(numericId)`, `getNumericIdForStable(stableId)`, `adoptStablePaneId(numericId, stableId)`, and `getStablePaneIdMap(): ReadonlyMap<number, string>` for serialization callers — returns a freshly constructed `Map`, not a live view of the manager's internal state, so concurrent pane closes during serialization can't mutate the snapshot.
- `src/renderer/src/components/terminal-pane/layout-serialization.ts` — extend `serializeTerminalLayout` to take `stablePaneIdByPaneId: ReadonlyMap<number, string>` (a snapshot of `PaneManager.getStablePaneIdMap()` at call time) and emit `stablePaneIdByLeafId` from it. The DOM walk already yields the numeric id per leaf; the map lifts it to the UUID without re‑deriving identity from the DOM. Teach `replayTerminalLayout` to call `adoptStablePaneId` when the snapshot has the field.
- `src/shared/types.ts` — add optional `stablePaneIdByLeafId?: Record<string, string>` to `TerminalLayoutSnapshot`.
- `src/renderer/src/components/terminal-pane/pty-connection.ts` — paneKey is minted at two producers in this file: `cacheKey` (line 116) and the `ORCA_PANE_KEY` env injection at pty:spawn (line 287). Both switch to `${deps.tabId}:${stablePaneId}`.
- `src/renderer/src/components/terminal-pane/TerminalPane.tsx` — three call sites mint paneKey for store dispatches: `setCacheTimerStartedAt` (line 411), `dropAgentStatus` (line 417), and a second `setCacheTimerStartedAt` (line 541). All switch to `${tabId}:${stablePaneId}`. Both call sites that invoke `serializeTerminalLayout` (`persistLayoutSnapshot` at line 301 AND `captureBuffers` shutdown at line 871) read `manager.getStablePaneIdMap()` and pass it as the new argument. The shutdown path matters specifically: that snapshot is what the next app launch replays, so missing `stablePaneIdByLeafId` there silently degrades every Cmd+Q→relaunch into the legacy‑snapshot path.
- `src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts:582` — `dropAgentStatus` mints paneKey here on close; switch to `${tabId}:${stablePaneId}`.
- `src/renderer/src/lib/pane-manager/mobile-fit-overrides.ts` — rename `ptyIdByPaneKey` → `ptyIdByInternalPaneKey` (or equivalent) at lines 89, 100, 111. This map is module‑private and never crosses a boundary, so it doesn't need UUIDs, but the cosmetic collision with paneKey is a footgun for future readers. The map's parser (`Number(key.split(':').pop())` at line 74) stays numeric — the key here is the renderer‑internal `${tabId}:${numericPaneId}`, not the cross‑boundary paneKey, so it doesn't migrate.
- `src/main/claude/hook-service.ts`, `src/main/cursor/hook-service.ts`, `src/main/gemini/hook-service.ts`, `src/main/codex/hook-service.ts`, `src/main/opencode/hook-service.ts` — no logic change; the env var value is supplied by pty-connection and forwarded opaquely.
- `src/renderer/src/hooks/useAutoAckViewedAgent.ts` — equality check on `${activeTabId}:${activeLeafStablePaneId}`. The hook reads `activeLeafStablePaneId` directly from the layout snapshot in the store: `useAppStore.getState().terminalLayoutsByTabId[activeTabId]?.stablePaneIdByLeafId?.[activeLeafId] ?? null`. No PaneManager reference is needed — the layout snapshot is the source of truth for both the active leaf and its stable id, and is the same place the hook already subscribes for the active‑tab/active‑view slices. Extend the reference‑equality short‑circuit to include `terminalLayoutsByTabId` (or the active‑tab layout entry) so within‑tab focus changes trigger a rescan.
- `src/renderer/src/components/sidebar/WorktreeCardAgents.tsx` — drop integer parsing; split paneKey at the first `:`; defer `acknowledgeAgents` to focus‑confirmation callback.
- `src/renderer/src/lib/activate-tab-and-focus-pane.ts` — `FocusTerminalPaneDetail` carries `stablePaneId: string` instead of `paneId: number`.
- `src/renderer/src/components/terminal-pane/use-terminal-pane-global-effects.ts:108` — resolve via `getNumericIdForStable`; surface stale on miss.
- `src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx:853-858` — stop parsing the paneKey suffix as an integer; pass it through to the focus dispatch as the opaque `stablePaneId`. Per‑pane title lookup takes `stablePaneId`.
- `src/renderer/src/components/status-bar/mergeSnapshotAndSessions.ts:140-152,170` — `parsePaneKey` and downstream consumers stop parsing the suffix as integer; `activateTabAndFocusPane` and per‑pane title lookups take `stablePaneId`. After `parsePaneKey` returns the opaque suffix, the per‑pane title lookup goes through the same `numericPaneIdByPaneKey` resolver.
- `src/renderer/src/hooks/useIpcEvents.ts:910-924` — in `resolvePaneKey`, after splitting paneKey into `tabId` and the opaque suffix, call `manager.getNumericIdForStable(suffix)` to resolve the renderer‑local numeric paneId for `runtimePaneTitlesByTabId` lookup. If the manager isn't reachable from this IPC layer (it isn't — `useIpcEvents` is a hook above any specific TerminalPane), maintain a small `Map<paneKey, numericId>` mirror in the store populated by PaneManager whenever it mints/adopts a stableId, so IPC‑layer code can resolve without a manager ref.
- `src/renderer/src/store/slices/terminals.ts` — **No change** — `runtimePaneTitlesByTabId` stays keyed by numeric `paneId`. It's renderer‑live state that never crosses a boundary; numeric handle is the right key. Consumers that today parse a paneKey suffix (`useIpcEvents.resolvePaneKey`, `mergeSnapshotAndSessions.parsePaneKey`) instead resolve through `manager.getNumericIdForStable(stablePaneId)` to recover the numeric handle for the title lookup. Other call sites (`pty-connection.ts`, `use-terminal-pane-lifecycle.ts`, `runtime/sync-runtime-graph.ts`) continue to pass `pane.id` directly — they already have it in scope.
- **`src/renderer/src/store/slices/terminals.ts` (or a new slice)** — add `numericPaneIdByPaneKey: Record<string, number>` written by PaneManager on pane create/adopt/close; read by IPC resolvers that need a numeric handle. Keeps the renderer‑local numeric id available without requiring a manager ref at the IPC layer.

### System diagram

```
                ┌──────────────────────────────────┐
                │ sidebar/WorktreeCardAgents       │
                │ paneKey = ${tabId}:${stableId}   │
                │ click → focus dispatch           │
                └────────────┬─────────────────────┘
                             │ activateTabAndFocusPane(tabId, stableId)
                             ▼
                ┌───────────────────────────────────┐
                │ activate-tab-and-focus-pane       │
                │ setActiveTab + rAF dispatch       │
                │ FOCUS_TERMINAL_PANE_EVENT         │
                │ (detail: tabId, stablePaneId)     │
                └────────────┬──────────────────────┘
                             │ CustomEvent
                             ▼
       ┌────────────────────────────────────────────┐
       │ use-terminal-pane-global-effects.ts:108    │
       │ onFocusPane:                               │
       │   numericId = mgr.getNumericIdForStable()  │
       │     ─ found  → setActivePane + ack on      │
       │                confirm                     │
       │     ─ miss   → surfaceStaleAgentRow,       │
       │                no ack                      │
       └────────────┬───────────────────────────────┘
                    │
                    ▼
            PaneManager (numeric ids may renumber on
            replay; stablePaneIds are restored from
            snapshot or minted fresh for new panes)


─── parallel path: auto-ack ───

Store change → useAutoAckViewedAgent.maybeAck
                 │
                 │ activeLeafStableId =
                 │   layout.stablePaneIdByLeafId[layout.activeLeafId]
                 │ targetKey = `${activeTabId}:${activeLeafStableId}`
                 │
                 │ === targetKey  (equality, not prefix)
                 │
                 ▼
         acknowledgeAgents([paneKey])
```

### Data flow paths

| Path | Today | With stable identity |
|------|-------|----------------------|
| **Happy** (paneKey matches a live pane) | Focus correct pane | `getNumericIdForStable` returns id → focus |
| **Nil** (malformed paneKey) | NaN paneId, silent miss | Stable id absent → `surfaceStaleAgentRow`, ack not recorded |
| **Empty** (no panes in tab) | `getActivePane() == null`, listener returns | Same; manager returns null id |
| **Upstream error** (renumber on replay; pane closed) | Silent miss or aliased focus | Snapshot stableId restored on replay → match. If pane is gone (closed), `surfaceStaleAgentRow` fires deterministically — no aliasing possible because stableIds are unique. |

## Tests

- **Unit, `useAutoAckViewedAgent.test.ts`** — extend the existing test that exercises `computeAutoAckTargets`:
  - Two‑pane case: same tab, two paneKeys, only the active leaf's key acks. The previous tab‑prefix behavior should explicitly *not* hold.
  - Three‑pane case: two of three panes carry agent rows; switching active leaf among the three updates which row acks.
  - Visibility/focus gates continue to suppress ack when window is hidden, even when active‑leaf equality matches.
- **Unit, focus listener** — a test for `use-terminal-pane-global-effects.ts`'s `onFocusPane` covering the three branches:
  - Exact match by stableId: `setActivePane` called.
  - Miss (stableId absent from manager): `surfaceStaleAgentRow` invoked; no `setActivePane`; row removed from `agentStatusByPaneKey`/`retainedAgentsByPaneKey`.
  - No manager: handler returns silently.
- **Unit, ack timing** — test that `handleActivateAgentTab` does NOT call `acknowledgeAgents` synchronously; ack happens only when the focus listener confirms `setActivePane` succeeded.
- **Unit, `pane-manager.ts`** — `createInitialPane` and `splitPane` mint distinct UUIDs; `adoptStablePaneId` reattaches a snapshot UUID to a freshly created numeric pane; `getStablePaneId` and `getNumericIdForStable` round‑trip.
- **Unit, `layout-serialization.ts`** — `serializeTerminalLayout` writes `stablePaneIdByLeafId`; `replayTerminalLayout` calls `adoptStablePaneId` for each leaf; legacy snapshots without the field replay correctly with freshly minted UUIDs.
- **Unit, migration filter** — hydrate the store with `agentStatusByPaneKey: { 'tab-1:5': {...} }` (legacy numeric suffix) and a layout snapshot containing `stablePaneIdByLeafId`. Assert: the legacy entry does not match any live `stablePaneIdByLeafId` value, gets surfaced via `surfaceStaleAgentRow` on first auto‑ack scan, and is dropped. Pair with a test asserting the IPC‑layer filter rejects an incoming hook event whose paneKey suffix is a number, not a UUID — covers both the hook‑bus path (case d) and the `lastStatusByPaneKey` replay path (case c).
- **Integration, hook services** — assert that the value placed in `ORCA_PANE_KEY` matches the paneKey suffix recorded in `agentStatusByPaneKey`. Treats the env var as opaque (no parsing on the test side beyond equality).
- **Integration, optional** — drive the renderer with `playwright-cli` per Repro A and assert `acknowledgedAgentsByPaneKey` *does not* contain the agent's paneKey while the active leaf is the blank one. Repeat after a renderer reload to confirm Repro B no longer reproduces (sidebar click lands on the agent's pane regardless of how the manager renumbered numeric ids).

## Migration & rollout

The migration is per‑PTY‑process, not per‑renderer: `ORCA_PANE_KEY` is injected into the shell's environment once at pty:spawn (`pty-connection.ts:287`) and is captured into that process's env for its lifetime. We can't rewrite a running shell's env retroactively, and daemon‑mode PTYs survive renderer reload, so we have to reason about four cases:

- **(a) Fresh layout, no retained agent state.** Clean. Every pane is created post‑upgrade with a UUID; every paneKey is in the new shape from the start.
- **(b) Layout with retained agent rows, no daemon (full app restart).** One‑time identity reset on first replay after upgrade: legacy snapshots replay without `stablePaneIdByLeafId`, so each pane gets a fresh UUID. Legacy paneKeys held in `agentStatusByPaneKey` / `retainedAgentsByPaneKey` from the old build no longer match anything; the user sees retained badges clear once. No data loss.
- **(c) Renderer‑only reload with main alive (Cmd+R).** The agent‑hooks server's `lastStatusByPaneKey` map (`src/main/agent-hooks/server.ts:65,1218,1289,1358,1372,1542`) replays the last‑known status entry to any new listener on connect. After a renderer reload without a main restart, that map still holds legacy paneKeys minted before the upgrade; replay fires `setAgentStatus(legacyPaneKey, ...)` into the new renderer and would populate orphan entries.
- **(d) Daemon‑survives‑reload.** Running shell processes still hold the legacy `ORCA_PANE_KEY` in their env permanently. Hooks invoked from those shells continue POSTing the legacy paneKey to the agent‑hooks server, which forwards it to the renderer.

Strategy for (c) and (d): a renderer‑side guard that drops any incoming agent‑hook event whose paneKey suffix isn't a UUID. The new format suffix is a v4 UUID (8‑4‑4‑4‑12 hex with dashes); the old format suffix is purely numeric. A regex check distinguishes them deterministically, so we don't need to maintain a legacy→new mapping. The trade‑off is that pre‑migration agents produce ignored events until they exit — acceptable because the affected PTYs are dev‑time only and short‑lived in practice, and the alternative (a bridging map) is durable extra state for a one‑time migration.

The guard lives at the renderer's IPC ingress — the `onAgentStatus` listener in `useIpcEvents.ts:856-869` — which is the single choke point through which both fresh hook events (`server.ts:1290`) and `lastStatusByPaneKey` replay (`server.ts:1218`) flow. The check is a v4 UUID regex on the suffix after the first `:`; rejection is a silent return. Placing the guard at IPC ingress (rather than in store mutators) keeps the renderer's internal `setAgentStatus` calls — including unit tests with `tab-1:5` fixtures — unaffected.

Concretely, update the existing claim about the hook server: the agent‑hooks server already treats paneKey as opaque (`server.ts:45,182`), but its `lastStatusByPaneKey` replay map can re‑inject pre‑migration paneKeys after a renderer reload. The renderer drops events whose paneKey suffix isn't a UUID. The same guard runs on every IPC ingress that could carry a paneKey from a pre‑migration source (hook events, last‑status replay).

`ORCA_PANE_KEY` format change is documented in release notes. Hook services in‑repo treat the value as opaque; user‑authored hook scripts that parse the numeric form must update.
