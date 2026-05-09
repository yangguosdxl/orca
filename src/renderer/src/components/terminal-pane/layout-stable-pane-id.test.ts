import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { replayTerminalLayout, serializeTerminalLayout } from './layout-serialization'

class MockHTMLElement {
  classList: { contains: (cls: string) => boolean }
  dataset: Record<string, string>
  children: MockHTMLElement[]
  style: Record<string, string>
  firstElementChild: MockHTMLElement | null

  constructor(opts: {
    classList?: string[]
    dataset?: Record<string, string>
    children?: MockHTMLElement[]
    style?: Record<string, string>
    firstElementChild?: MockHTMLElement | null
  }) {
    const classes = opts.classList ?? []
    this.classList = { contains: (cls: string) => classes.includes(cls) }
    this.dataset = opts.dataset ?? {}
    this.children = opts.children ?? []
    this.style = opts.style ?? {}
    this.firstElementChild = opts.firstElementChild ?? null
  }
}

let originalHTMLElement: unknown

beforeAll(() => {
  const globalRecord = globalThis as unknown as Record<string, unknown>
  originalHTMLElement = globalRecord.HTMLElement
  globalRecord.HTMLElement = MockHTMLElement
})

afterAll(() => {
  const globalRecord = globalThis as unknown as Record<string, unknown>
  if (originalHTMLElement === undefined) {
    delete globalRecord.HTMLElement
  } else {
    globalRecord.HTMLElement = originalHTMLElement
  }
})

function mockElement(opts: {
  classList?: string[]
  dataset?: Record<string, string>
  children?: MockHTMLElement[]
  style?: Record<string, string>
  firstElementChild?: MockHTMLElement | null
}): HTMLElement {
  return new MockHTMLElement(opts) as unknown as HTMLElement
}

describe('layout stablePaneId persistence', () => {
  it('keeps stablePaneId attached to pane leaf ids when pane DOM order changes', () => {
    const leaf1 = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '1' } })
    const leaf2 = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '2' } })
    const stableMap = new Map<number, string>([
      [1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      [2, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
    ])

    const originalSplit = new MockHTMLElement({
      classList: ['pane-split'],
      children: [leaf1, leaf2]
    })
    const movedSplit = new MockHTMLElement({
      classList: ['pane-split'],
      children: [leaf2, leaf1]
    })

    const original = serializeTerminalLayout(
      mockElement({ firstElementChild: originalSplit }) as unknown as HTMLDivElement,
      1,
      null,
      stableMap
    )
    const moved = serializeTerminalLayout(
      mockElement({ firstElementChild: movedSplit }) as unknown as HTMLDivElement,
      1,
      null,
      stableMap
    )

    // Why: drag-moving panes changes visual/tree order, not pane identity.
    // UUIDs must follow the pane leaf id (`pane:N`), not the leaf's position.
    expect(original.stablePaneIdByLeafId).toEqual(moved.stablePaneIdByLeafId)
    expect(moved.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'pane:2' },
      second: { type: 'leaf', leafId: 'pane:1' }
    })
  })

  it('hints snapshot UUIDs at mint time so cacheKey-capturing onPaneCreated sees them', () => {
    // Why: capture each create call with its hint to assert the new contract —
    // hints flow at mint time (rather than via adoptStablePaneId-after-mint),
    // closing the race where onPaneCreated → connectPanePty would otherwise
    // capture a freshly-minted UUID instead of the snapshot's UUID.
    const initialCalls: { stablePaneIdHint?: string }[] = []
    const splitCalls: { paneId: number; stablePaneIdHint?: string }[] = []
    const adopted: [number, string][] = []
    let nextPaneId = 1
    const manager = {
      createInitialPane: (opts: { focus?: boolean; stablePaneIdHint?: string }) => {
        initialCalls.push({ stablePaneIdHint: opts?.stablePaneIdHint })
        return { id: nextPaneId++ }
      },
      splitPane: (
        paneId: number,
        _direction: string,
        opts: { ratio?: number; stablePaneIdHint?: string }
      ) => {
        splitCalls.push({ paneId, stablePaneIdHint: opts?.stablePaneIdHint })
        return { id: nextPaneId++ }
      },
      adoptStablePaneId: (numericId: number, stablePaneId: string) => {
        adopted.push([numericId, stablePaneId])
      }
    }

    const snapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'leaf-a' },
          second: { type: 'leaf', leafId: 'leaf-b' }
        },
        second: { type: 'leaf', leafId: 'leaf-c' }
      },
      activeLeafId: 'leaf-b',
      expandedLeafId: null,
      stablePaneIdByLeafId: {
        'leaf-a': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'leaf-b': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'leaf-c': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      }
    } satisfies Parameters<typeof replayTerminalLayout>[1]

    const paneByLeafId = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      snapshot,
      false
    )

    // Why: replay creates panes in split traversal order (`a`, `c`, `b` here),
    // so numeric ids can move. Persisted UUIDs must still restore by leaf id.
    expect(Object.fromEntries(paneByLeafId)).toEqual({
      'leaf-a': 1,
      'leaf-c': 2,
      'leaf-b': 3
    })

    // Initial pane corresponds to leaf-a (leftmost leaf of the snapshot root).
    expect(initialCalls).toEqual([{ stablePaneIdHint: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }])
    // First split creates pane 2 = leaf-c (leftmost of node.second of the
    // outer split). Second split creates pane 3 = leaf-b (leftmost of
    // node.second of the inner horizontal split).
    expect(splitCalls).toEqual([
      { paneId: 1, stablePaneIdHint: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      { paneId: 1, stablePaneIdHint: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    ])

    // adoptStablePaneId remains as a defensive late-binding fallback. Calls
    // here are no-ops in production (the manager checks previousStable ===
    // stablePaneId), but this fake doesn't model that — verify the leafId →
    // numeric mapping was preserved instead.
    expect(adopted).toEqual([
      [1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      [3, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      [2, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']
    ])
  })

  it('skips late UUID adoption for collapsed leaves when split replay fails', () => {
    const adopted: [number, string][] = []
    let nextPaneId = 1
    let splitCount = 0
    const manager = {
      createInitialPane: () => ({ id: nextPaneId++ }),
      splitPane: () => {
        splitCount += 1
        // Why: fail the nested split only. replayTerminalLayout then maps both
        // nested leaves onto pane 2; late adoption must not assign two snapshot
        // UUIDs to that one surviving pane.
        if (splitCount === 2) {
          return null
        }
        return { id: nextPaneId++ }
      },
      adoptStablePaneId: (numericId: number, stablePaneId: string) => {
        adopted.push([numericId, stablePaneId])
      }
    }

    const snapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-a' },
        second: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'leaf-b' },
          second: { type: 'leaf', leafId: 'leaf-c' }
        }
      },
      activeLeafId: 'leaf-a',
      expandedLeafId: null,
      stablePaneIdByLeafId: {
        'leaf-a': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'leaf-b': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'leaf-c': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      }
    } satisfies Parameters<typeof replayTerminalLayout>[1]

    const paneByLeafId = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      snapshot,
      false
    )

    expect(Object.fromEntries(paneByLeafId)).toEqual({
      'leaf-a': 1,
      'leaf-b': 2,
      'leaf-c': 2
    })
    expect(adopted).toEqual([[1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']])
  })
})
