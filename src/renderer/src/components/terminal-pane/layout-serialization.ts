import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../../shared/types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { replayIntoTerminal, type ReplayingPanesRef } from './replay-guard'

export const EMPTY_LAYOUT: TerminalLayoutSnapshot = {
  root: null,
  activeLeafId: null,
  expandedLeafId: null
}

// Why: xterm's SerializeAddon captures display state by emitting mode-setting
// bytes (e.g. `\e[?1004h` for focus reporting) so a re-fed emulator lands in
// the same mode as the snapshot source. That's correct for tmux-style
// "attach to a still-running TUI" — but Orca restores scrollback against a
// *fresh* shell, with no TUI to consume those modes. A stale focus-reporting
// bit causes xterm to emit `\e[I`/`\e[O` on every pane click, which the
// fresh zsh treats as unbound key input and rings the bell for.
//
// Reset the interactive modes most commonly left set by crashed/ended TUIs
// so replayed mode bits do not leak into the fresh shell. ghostty achieves
// the same end by not restoring state at all.
//
//   25                  — DECTCEM cursor visibility (SerializeAddon captures
//                         `?25l` when the cursor was hidden at snapshot time;
//                         without an explicit `?25h` here the cursor stays
//                         invisible in the restored terminal)
//   1000/1002/1003/1006 — mouse reporting variants
//   1004                — focus event reporting (the actual bug source)
//   2004                — bracketed paste
export const POST_REPLAY_MODE_RESET =
  '\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l'

// Why: daemon snapshot restore reattaches to a live session, so we avoid the
// full POST_REPLAY_MODE_RESET bundle there — a still-running TUI may still
// rely on mouse or bracketed-paste modes. Two exceptions are safe to reset:
//
//   25   — DECTCEM cursor visibility: SerializeAddon bakes `?25l` into the
//          snapshot when the cursor was hidden at capture time. Without `?25h`
//          here the cursor stays invisible after reattach. If a TUI is still
//          running and wants the cursor hidden, the SIGWINCH sent immediately
//          after restore triggers a repaint that re-hides it — a brief flash
//          that is far less harmful than a permanently invisible cursor.
//   1004 — focus event reporting: preserving `?1004h` makes restored shells
//          ring BEL on pane focus/blur (shells like zsh treat `\e[I`/`\e[O`
//          as unbound key input).
export const POST_REPLAY_FOCUS_REPORTING_RESET = '\x1b[?25h\x1b[?1004l'

export function paneLeafId(paneId: number): string {
  return `pane:${paneId}`
}

export function collectLeafIdsInOrder(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeafIdsInOrder(node.first), ...collectLeafIdsInOrder(node.second)]
}

function getLeftmostLeafId(node: TerminalPaneLayoutNode): string {
  return node.type === 'leaf' ? node.leafId : getLeftmostLeafId(node.first)
}

function collectReplayCreatedPaneLeafIds(
  node: Extract<TerminalPaneLayoutNode, { type: 'split' }>,
  leafIdsInReplayCreationOrder: string[]
): void {
  // Why: replayTerminalLayout() creates one new pane per split and assigns it
  // to the split's second subtree before recursing, so the new pane maps to
  // the leftmost leaf reachable within that second subtree.
  leafIdsInReplayCreationOrder.push(getLeftmostLeafId(node.second))

  if (node.first.type === 'split') {
    collectReplayCreatedPaneLeafIds(node.first, leafIdsInReplayCreationOrder)
  }
  if (node.second.type === 'split') {
    collectReplayCreatedPaneLeafIds(node.second, leafIdsInReplayCreationOrder)
  }
}

export function collectLeafIdsInReplayCreationOrder(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  const leafIdsInReplayCreationOrder = [getLeftmostLeafId(node)]
  if (node.type === 'split') {
    collectReplayCreatedPaneLeafIds(node, leafIdsInReplayCreationOrder)
  }
  return leafIdsInReplayCreationOrder
}

// Cross-platform monospace fallback chain ensures the terminal always has a
// usable font regardless of OS.  macOS-only fonts like SF Mono and Menlo are
// harmless on other platforms (the browser skips them), while Cascadia Mono /
// Consolas cover Windows and DejaVu Sans Mono / Liberation Mono cover Linux.
//
// Why Nerd Fonts are listed just before `monospace`: Powerline prompts (p10k,
// starship, oh-my-zsh) and many shell plugins emit glyphs in the Unicode
// Private Use Area (U+E000–U+F8FF) that no standard monospace font contains.
// When the user's primary font (e.g. SF Mono) is missing those code points
// the browser walks the fallback chain character-by-character, so adding
// commonly-installed Nerd Fonts here lets PUA glyphs render correctly without
// forcing the user to override their terminal font. Placed AFTER the regular
// system fonts so ASCII text still renders in the user's chosen font rather
// than being substituted by a Nerd Font variant.
const FALLBACK_FONTS = [
  'SF Mono', // macOS 10.12+
  'Menlo', // macOS (older)
  'Monaco', // macOS (legacy)
  'Cascadia Mono', // Windows 11+
  'Consolas', // Windows Vista+
  'DejaVu Sans Mono', // Linux (common)
  'Liberation Mono', // Linux (common)
  'Symbols Nerd Font Mono', // purpose-built Nerd Fonts symbols-only fallback
  'MesloLGS Nerd Font', // p10k's recommended font; very common on zsh setups
  'JetBrainsMono Nerd Font', // widely installed; Ghostty ships a JBM-derived font
  'Hack Nerd Font', // common Nerd Font among Linux developers
  'monospace' // ultimate generic fallback
] as const

export function buildFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim()
  const parts = trimmed ? [`"${trimmed}"`] : []
  const lowerParts = parts.map((p) => p.toLowerCase())
  // Append each fallback unless the user's font name already contains it
  // (case-insensitive) to avoid duplicates like '"SF Mono", "SF Mono"'.
  for (const fallback of FALLBACK_FONTS) {
    const lower = fallback.toLowerCase()
    if (!lowerParts.some((p) => p.includes(lower))) {
      // Generic keywords like "monospace" are unquoted; named fonts are quoted.
      parts.push(fallback === 'monospace' ? fallback : `"${fallback}"`)
    }
  }
  return parts.join(', ')
}

export function getLayoutChildNodes(split: HTMLElement): HTMLElement[] {
  return Array.from(split.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
  )
}

export function serializePaneTree(node: HTMLElement | null): TerminalPaneLayoutNode | null {
  if (!node) {
    return null
  }

  if (node.classList.contains('pane')) {
    const paneId = Number(node.dataset.paneId ?? '')
    if (!Number.isFinite(paneId)) {
      return null
    }
    return { type: 'leaf', leafId: paneLeafId(paneId) }
  }

  if (!node.classList.contains('pane-split')) {
    return null
  }
  const [first, second] = getLayoutChildNodes(node)
  const firstNode = serializePaneTree(first ?? null)
  const secondNode = serializePaneTree(second ?? null)
  if (!firstNode || !secondNode) {
    return null
  }

  // Capture the flex ratio so resized panes survive serialization round-trips.
  // We read the computed flex-grow values to derive the first-child proportion.
  let ratio: number | undefined
  if (first && second) {
    const firstGrow = parseFloat(first.style.flex) || 1
    const secondGrow = parseFloat(second.style.flex) || 1
    const total = firstGrow + secondGrow
    if (total > 0) {
      const r = firstGrow / total
      // Only store if meaningfully different from 0.5 (default equal split)
      if (Math.abs(r - 0.5) > 0.005) {
        ratio = Math.round(r * 1000) / 1000
      }
    }
  }

  return {
    type: 'split',
    direction: node.classList.contains('is-horizontal') ? 'horizontal' : 'vertical',
    first: firstNode,
    second: secondNode,
    ...(ratio !== undefined && { ratio })
  }
}

export function serializeTerminalLayout(
  root: HTMLDivElement | null,
  activePaneId: number | null,
  expandedPaneId: number | null,
  stablePaneIdByPaneId?: ReadonlyMap<number, string>
): TerminalLayoutSnapshot {
  const rootNode = serializePaneTree(
    root?.firstElementChild instanceof HTMLElement ? root.firstElementChild : null
  )
  const snapshot: TerminalLayoutSnapshot = {
    root: rootNode,
    activeLeafId: activePaneId === null ? null : paneLeafId(activePaneId),
    expandedLeafId: expandedPaneId === null ? null : paneLeafId(expandedPaneId)
  }
  // Why: persist stablePaneId per leaf so layout replay rebinds the same UUID
  // to the corresponding leaf, preserving the cross-boundary paneKey identity
  // that retained agent rows + ORCA_PANE_KEY hooks rely on. The DOM walk
  // already produced the numeric paneId per leaf; this lift uses the snapshot
  // map (taken from PaneManager.getStablePaneIdMap()) to map numeric → UUID
  // without re-deriving identity from the DOM. Skipped when the caller didn't
  // pass the map (legacy call sites or tests that don't have a manager).
  if (stablePaneIdByPaneId && stablePaneIdByPaneId.size > 0 && rootNode) {
    const stablePaneIdByLeafId: Record<string, string> = {}
    for (const leafId of collectLeafIdsInOrder(rootNode)) {
      const numericId = parsePaneIdFromLeafId(leafId)
      if (numericId === null) {
        continue
      }
      const stableId = stablePaneIdByPaneId.get(numericId)
      if (stableId) {
        stablePaneIdByLeafId[leafId] = stableId
      }
    }
    if (Object.keys(stablePaneIdByLeafId).length > 0) {
      snapshot.stablePaneIdByLeafId = stablePaneIdByLeafId
    }
  }
  return snapshot
}

function parsePaneIdFromLeafId(leafId: string): number | null {
  if (!leafId.startsWith('pane:')) {
    return null
  }
  const tail = leafId.slice('pane:'.length)
  // Why: nextPaneId only allocates positive integers starting at 1. Use a strict
  // digit regex (rather than Number(tail)) to reject non-canonical inputs like
  // '1e3', '+2', ' 3 ', or leading zeros that Number() would silently coerce.
  if (!/^[1-9]\d*$/.test(tail)) {
    return null
  }
  return Number.parseInt(tail, 10)
}

function collectLeafIds(
  node: TerminalPaneLayoutNode,
  paneByLeafId: Map<string, number>,
  paneId: number
): void {
  if (node.type === 'leaf') {
    paneByLeafId.set(node.leafId, paneId)
    return
  }
  collectLeafIds(node.first, paneByLeafId, paneId)
  collectLeafIds(node.second, paneByLeafId, paneId)
}

/**
 * Write saved scrollback buffers into the restored panes so the user sees
 * their previous terminal output after an app restart.  If a buffer was
 * captured while the alternate screen was active (e.g. an agent TUI was
 * running at shutdown), we exit alt-screen first so the user sees a usable
 * normal-mode terminal.
 */
export function restoreScrollbackBuffers(
  manager: PaneManager,
  savedBuffers: Record<string, string> | undefined,
  restoredPaneByLeafId: Map<string, number>,
  replayingPanesRef: ReplayingPanesRef
): void {
  if (!savedBuffers) {
    return
  }
  const ALT_SCREEN_ON = '\x1b[?1049h'
  const ALT_SCREEN_OFF = '\x1b[?1049l'
  for (const [oldLeafId, buffer] of Object.entries(savedBuffers)) {
    const newPaneId = restoredPaneByLeafId.get(oldLeafId)
    if (newPaneId == null || !buffer) {
      continue
    }
    const pane = manager.getPanes().find((p) => p.id === newPaneId)
    if (!pane) {
      continue
    }
    try {
      let buf = buffer
      // If buffer ends in alt-screen mode (agent TUI was running at
      // shutdown), exit alt-screen so the user sees a usable terminal.
      const lastOn = buf.lastIndexOf(ALT_SCREEN_ON)
      const lastOff = buf.lastIndexOf(ALT_SCREEN_OFF)
      if (lastOn > lastOff) {
        buf = buf.slice(0, lastOn)
      }
      if (buf.length > 0) {
        // Why replayIntoTerminal: the serialized buffer can contain query
        // sequences from the prior session (DA1, DECRQM, OSC 10/11, focus,
        // CPR). Writing those through xterm.write would trigger auto-replies
        // that land in the new shell's stdin. See replay-guard.ts.
        replayIntoTerminal(pane, replayingPanesRef, buf)
        // Ensure cursor is on a new line so the new shell prompt
        // doesn't trigger zsh's PROMPT_EOL_MARK (%) indicator.
        replayIntoTerminal(pane, replayingPanesRef, '\r\n')
        // Clear any mode bits the serialized buffer replayed into xterm.
        // The shell underneath is fresh and has no TUI consuming these modes.
        // See POST_REPLAY_MODE_RESET comment.
        replayIntoTerminal(pane, replayingPanesRef, POST_REPLAY_MODE_RESET)
      }
    } catch {
      // If restore fails, continue with blank terminal.
    }
  }
}

export function replayTerminalLayout(
  manager: PaneManager,
  snapshot: TerminalLayoutSnapshot | null | undefined,
  focusInitialPane: boolean
): Map<string, number> {
  const paneByLeafId = new Map<string, number>()

  // Why: pass the snapshot UUID at mint time rather than swapping it in via
  // adoptStablePaneId after the panes are created. createInitialPane and
  // splitPane fire onPaneCreated synchronously, which invokes connectPanePty,
  // which captures cacheKey from pane.stablePaneId — so any post-mint adoption
  // would lose to that synchronous read and silently bypass the entire
  // stable-pane-id migration on every layout restore. The createdPane after
  // splitPane(parent, dir) corresponds to the leftmost leaf in `node.second`
  // (the new subtree), so we hint with that snapshot leaf's UUID.
  const stableIdByLeafId = snapshot?.stablePaneIdByLeafId
  const hintFor = (leafId: string | undefined): string | undefined =>
    leafId && stableIdByLeafId ? stableIdByLeafId[leafId] : undefined

  const initialLeafId = snapshot?.root ? getLeftmostLeafId(snapshot.root) : undefined
  const initialPane = manager.createInitialPane({
    focus: focusInitialPane,
    stablePaneIdHint: hintFor(initialLeafId)
  })
  if (!snapshot?.root) {
    paneByLeafId.set(paneLeafId(initialPane.id), initialPane.id)
    return paneByLeafId
  }

  const restoreNode = (node: TerminalPaneLayoutNode, paneId: number): void => {
    if (node.type === 'leaf') {
      paneByLeafId.set(node.leafId, paneId)
      return
    }

    const createdLeafId = getLeftmostLeafId(node.second)
    const createdPane = manager.splitPane(paneId, node.direction as TerminalPaneSplitDirection, {
      ratio: node.ratio,
      stablePaneIdHint: hintFor(createdLeafId)
    })
    if (!createdPane) {
      collectLeafIds(node, paneByLeafId, paneId)
      return
    }

    restoreNode(node.first, paneId)
    restoreNode(node.second, createdPane.id)
  }

  restoreNode(snapshot.root, initialPane.id)

  // Why: when splitPane fails inside restoreNode, collectLeafIds collapses
  // every leaf in the failed subtree onto the same numericId. Detect those
  // collapsed numericIds up front so the late-binding adopt loop can skip
  // them — see comment inside the loop.
  const duplicatedNumericIds = new Set<number>()
  const seenNumericIds = new Set<number>()
  for (const numericId of paneByLeafId.values()) {
    if (seenNumericIds.has(numericId)) {
      duplicatedNumericIds.add(numericId)
    } else {
      seenNumericIds.add(numericId)
    }
  }

  // Why: defensive late-binding fallback. Mint-time hints (above) handle the
  // common path; this only fires for leaves whose snapshot UUID either failed
  // the v4 guard or collided with a live pane at mint time. adoptStablePaneId
  // is a no-op when the pane already holds the snapshot UUID.
  if (stableIdByLeafId) {
    for (const [leafId, stableId] of Object.entries(stableIdByLeafId)) {
      const numericId = paneByLeafId.get(leafId)
      if (numericId == null || !stableId) {
        continue
      }
      // Why: split-failed subtrees collapse every leaf onto the same numericId.
      // adoptStablePaneId would then overwrite previous→new for each iteration,
      // silently dropping every leaf's UUID except the last. Skip the adoption
      // entirely for those collapsed leaves — better to keep the freshly minted
      // UUID than to assign one snapshot UUID to a pane representing N leaves.
      if (duplicatedNumericIds.has(numericId)) {
        continue
      }
      manager.adoptStablePaneId(numericId, stableId)
    }
  }
  return paneByLeafId
}
