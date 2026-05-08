import { describe, expect, it, vi } from 'vitest'

// Why: PaneManager pulls in xterm + addon modules whose ESM bundles touch
// browser-only globals at import time. Mock them to bare classes so the test
// surface stays focused on the stablePaneId identity contract — the real DOM
// + xterm wiring is exercised by pane-lifecycle.test.ts.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    parser = { registerOscHandler: () => ({ dispose: () => {} }) }
    focus(): void {}
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
vi.mock('@xterm/addon-ligatures', () => ({ LigaturesAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    serialize(): string {
      return ''
    }
    dispose(): void {}
  }
}))

// Why: bypass the real DOM-dependent createPaneDOM/openTerminal so the tests
// can run in vitest's default node env. PaneManager only needs createPaneDOM
// to return a pane-shaped object whose `id` and `stablePaneId` match what it
// passed in, plus disposable hooks for closePane/destroy.
vi.mock('./pane-lifecycle', async () => {
  return {
    createPaneDOM: (id: number, stablePaneId: string) => ({
      id,
      stablePaneId,
      terminal: { focus: () => {}, dispose: () => {} },
      container: makeFakeElement(),
      xtermContainer: makeFakeElement(),
      linkTooltip: makeFakeElement(),
      terminalGpuAcceleration: 'auto',
      gpuRenderingEnabled: false,
      webglAttachmentDeferred: false,
      webglDisabledAfterContextLoss: false,
      fitAddon: { fit: () => {}, dispose: () => {}, proposeDimensions: () => null },
      fitResizeObserver: null,
      pendingObservedFitRafId: null,
      searchAddon: { dispose: () => {} },
      serializeAddon: { dispose: () => {}, serialize: () => '' },
      unicode11Addon: { dispose: () => {} },
      webLinksAddon: { dispose: () => {} },
      webglAddon: null,
      ligaturesAddon: null,
      compositionHandler: null,
      pendingSplitScrollState: null,
      debugLabel: null
    }),
    openTerminal: () => {},
    disposeWebgl: () => {},
    attachWebgl: () => {},
    setLigaturesEnabled: () => {},
    disposePane: (pane: { id: number }, panes: Map<number, unknown>) => {
      panes.delete(pane.id)
    }
  }
})

vi.mock('./pane-tree-ops', () => ({
  findPaneChildren: () => [],
  removeDividers: () => {},
  promoteSibling: () => {},
  wrapInSplit: () => {},
  safeFit: () => {},
  fitAllPanesInternal: () => {},
  captureScrollState: () => null,
  refitPanesUnder: () => {}
}))
vi.mock('./pane-split-scroll', () => ({ scheduleSplitScrollRestore: () => {} }))
vi.mock('./pane-divider', () => ({
  createDivider: () => makeFakeElement(),
  applyDividerStyles: () => {},
  applyPaneOpacity: () => {},
  applyRootBackground: () => {}
}))
vi.mock('./pane-drag-reorder', () => ({
  createDragReorderState: () => ({}),
  hideDropOverlay: () => {},
  handlePaneDrop: () => {},
  updateMultiPaneState: () => {}
}))
vi.mock('./pane-terminal-gpu-acceleration', () => ({ applyTerminalGpuAcceleration: () => {} }))
vi.mock('./pane-webgl-reattach', () => ({ reattachWebglIfNeeded: () => {} }))
vi.mock('./focus-follows-mouse', () => ({ shouldFollowMouseFocus: () => false }))

import { PaneManager } from './pane-manager'

// Why: PaneManager appends/removes children on the root element. We don't run
// in jsdom so the renderer DOM types aren't available — provide a minimal
// shim with the methods the manager actually calls. PaneManager only uses
// appendChild + innerHTML on the root, so this is enough.
function makeFakeElement(): HTMLElement {
  const children: unknown[] = []
  const element = {
    children,
    classList: {
      contains: () => false,
      add: () => {},
      remove: () => {}
    },
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    appendChild: (child: unknown) => {
      children.push(child)
      return child
    },
    removeChild: (child: unknown) => {
      const idx = children.indexOf(child)
      if (idx !== -1) {
        children.splice(idx, 1)
      }
      return child
    },
    parentElement: null as HTMLElement | null,
    addEventListener: () => {},
    removeEventListener: () => {},
    set innerHTML(_v: string) {
      children.length = 0
    },
    get innerHTML(): string {
      return ''
    }
  }
  return element as unknown as HTMLElement
}

describe('PaneManager — stablePaneId', () => {
  it('mints a UUID for createInitialPane and round-trips numeric ↔ stable', () => {
    const mgr = new PaneManager(makeFakeElement(), {})
    const pane = mgr.createInitialPane({ focus: false })
    expect(pane.stablePaneId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(mgr.getStablePaneId(pane.id)).toBe(pane.stablePaneId)
    expect(mgr.getNumericIdForStable(pane.stablePaneId)).toBe(pane.id)
  })

  it('mints unique UUIDs across many panes (verified via getStablePaneIdMap)', () => {
    // Why: splitPane requires a real parent-element graph that this fake DOM
    // doesn't model. Validate uniqueness by looping createInitialPane through
    // sibling managers — the UUID source (mintStablePaneId) is shared, so a
    // collision in any of them would surface here.
    const ids = new Set<string>()
    for (let i = 0; i < 4; i++) {
      const mgr = new PaneManager(makeFakeElement(), {})
      const pane = mgr.createInitialPane({ focus: false })
      ids.add(pane.stablePaneId)
    }
    expect(ids.size).toBe(4)
  })

  it('adoptStablePaneId rebinds the snapshot UUID and drops the previous mapping', () => {
    const mgr = new PaneManager(makeFakeElement(), {})
    const pane = mgr.createInitialPane({ focus: false })
    const minted = pane.stablePaneId
    const snapshotId = '11111111-1111-4111-8111-111111111111'
    mgr.adoptStablePaneId(pane.id, snapshotId)
    expect(mgr.getStablePaneId(pane.id)).toBe(snapshotId)
    expect(mgr.getNumericIdForStable(snapshotId)).toBe(pane.id)
    // Previous UUID must no longer resolve.
    expect(mgr.getNumericIdForStable(minted)).toBeNull()
  })

  it('adoptStablePaneId is a no-op for the unchanged UUID', () => {
    const adopted: string[] = []
    const mgr = new PaneManager(makeFakeElement(), {
      onStableIdAdopted: (id, stable) => adopted.push(`${id}:${stable}`)
    })
    const pane = mgr.createInitialPane({ focus: false })
    mgr.adoptStablePaneId(pane.id, pane.stablePaneId)
    expect(adopted).toEqual([])
  })

  it('getStablePaneIdMap returns a fresh Map each call', () => {
    const mgr = new PaneManager(makeFakeElement(), {})
    const a = mgr.createInitialPane({ focus: false })
    const map1 = mgr.getStablePaneIdMap()
    const map2 = mgr.getStablePaneIdMap()
    expect(map1).not.toBe(map2)
    expect(map1.get(a.id)).toBe(a.stablePaneId)
  })

  it('fires onStableIdRegistered for each new pane', () => {
    const registered: [number, string][] = []
    const mgr = new PaneManager(makeFakeElement(), {
      onStableIdRegistered: (numericId, stable) => registered.push([numericId, stable])
    })
    const a = mgr.createInitialPane({ focus: false })
    expect(registered).toEqual([[a.id, a.stablePaneId]])
  })

  it('adoptStablePaneId fires onStableIdAdopted with the previous UUID', () => {
    const adopted: [number, string, string | null][] = []
    const mgr = new PaneManager(makeFakeElement(), {
      onStableIdAdopted: (numericId, stable, previous) =>
        adopted.push([numericId, stable, previous])
    })
    const pane = mgr.createInitialPane({ focus: false })
    const minted = pane.stablePaneId
    const snapshotId = '22222222-2222-4222-8222-222222222222'
    mgr.adoptStablePaneId(pane.id, snapshotId)
    expect(adopted).toEqual([[pane.id, snapshotId, minted]])
  })
})
