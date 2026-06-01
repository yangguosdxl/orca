/* eslint-disable max-lines -- Why: this suite shares a broad mocked sidebar
   harness across compact/full mode, lineage, and image-note cases. */
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockAgentOptions = {
  paneKey?: string
  tabId?: string
  agentType?: string
  state?: string
  startedAt?: number
  prompt?: string
  lastAssistantMessage?: string
  stateStartedAt?: number
  orchestration?: { parentPaneKey: string }
  lineage?: {
    depth: number
    isFirstSibling: boolean
    isLastSibling: boolean
    childCount: number
  }
}

function mockAgent({
  paneKey = 'tab-1:1',
  tabId = paneKey.split(':')[0],
  agentType,
  state = 'working',
  startedAt,
  prompt,
  lastAssistantMessage,
  stateStartedAt = 1000,
  orchestration,
  lineage
}: MockAgentOptions = {}): unknown {
  return {
    paneKey,
    tab: { id: tabId },
    agentType,
    state,
    startedAt,
    entry: {
      prompt,
      lastAssistantMessage,
      state,
      stateStartedAt,
      stateHistory: prompt === undefined ? undefined : [],
      orchestration
    },
    lineage
  }
}

let mockAgents: unknown[] = [mockAgent()]
let mockFocusedAgentPaneKey: string | null = null
let mockAgentActivityDisplayMode: 'compact' | 'full' | undefined
let mockExperimentalAgentTerminalPopover = false
let mockLiveTabIds = ['tab-1']
let mockTerminalLayoutsByTabId: Record<string, unknown> = {}

function mockLayoutForLeaf(leafId: string): unknown {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null
  }
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: mockAgentActivityDisplayMode,
      acknowledgedAgentsByPaneKey: {},
      settings: { experimentalAgentTerminalPopover: mockExperimentalAgentTerminalPopover },
      dropAgentStatus: vi.fn(),
      dismissRetainedAgent: vi.fn(),
      acknowledgeAgents: vi.fn(),
      agentSendPopoverTargetMode: null,
      agentStatusByPaneKey: {},
      tabsByWorktree: { 'wt-1': mockLiveTabIds.map((id) => ({ id })) },
      terminalLayoutsByTabId: mockTerminalLayoutsByTabId,
      sendPromptToSidebarAgentTarget: vi.fn()
    })
}))

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => mockAgents)
}))

vi.mock('@/components/dashboard/useNow', () => ({
  useNow: vi.fn(() => 2000)
}))

vi.mock('@/components/dashboard/DashboardAgentRow', () => ({
  default: ({
    agent,
    isFocusedPane,
    sendTargetStatus,
    sendTargetDisabledReason,
    onSendTargetClick,
    childAgentCount,
    childAgentsExpanded,
    onToggleChildAgents,
    renderRowPopover
  }: {
    agent: { paneKey: string }
    isFocusedPane?: boolean
    sendTargetStatus?: 'eligible' | 'disabled' | 'sending'
    sendTargetDisabledReason?: string
    onSendTargetClick?: (paneKey: string) => void
    childAgentCount?: number
    childAgentsExpanded?: boolean
    onToggleChildAgents?: () => void
    renderRowPopover?: (args: {
      children: ReactNode
      agentName: string
      statusLabel: string
    }) => ReactNode
  }) => {
    const row = (
      <div
        data-testid="agent-row"
        data-focused={isFocusedPane ? 'true' : 'false'}
        data-agent-send-target={sendTargetStatus}
        data-disabled-reason={sendTargetDisabledReason}
        data-has-send-handler={typeof onSendTargetClick === 'function' ? 'true' : 'false'}
        data-pane-key={agent.paneKey}
        data-popover={renderRowPopover ? 'true' : 'false'}
      >
        {agent.paneKey}
        {typeof childAgentCount === 'number' && childAgentCount > 0 ? (
          <button
            type="button"
            aria-label={`${childAgentsExpanded ? 'Hide' : 'Show'} ${childAgentCount} child ${
              childAgentCount === 1 ? 'agent' : 'agents'
            }`}
            aria-expanded={childAgentsExpanded ?? false}
            onClick={onToggleChildAgents}
          >
            +{childAgentCount}
          </button>
        ) : null}
      </div>
    )
    return renderRowPopover
      ? renderRowPopover({ children: row, agentName: agent.paneKey, statusLabel: 'Working' })
      : row
  }
}))

vi.mock('./focused-agent-row-highlight', () => ({
  useFocusedAgentPaneKey: vi.fn(() => mockFocusedAgentPaneKey)
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

describe('WorktreeCardAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgents = [mockAgent()]
    mockFocusedAgentPaneKey = null
    mockAgentActivityDisplayMode = undefined
    mockExperimentalAgentTerminalPopover = false
    mockLiveTabIds = ['tab-1']
    mockTerminalLayoutsByTabId = {}
  })

  it('renders ordinary rows in full mode without a child disclosure', async () => {
    mockAgentActivityDisplayMode = 'full'
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="group"')
    expect(markup).toContain('aria-label="Agents"')
    expect(markup).toContain('data-testid="agent-row"')
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('aria-expanded')
  })

  it('uses compact mode when the display preference is absent', async () => {
    mockAgents = [mockAgent({ agentType: 'codex', startedAt: 1000, prompt: 'Run tests' })]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="group"')
    expect(markup).toContain('Run tests')
    expect(markup).toContain('title="Codex"')
    expect(markup).not.toContain('data-testid="agent-row"')
  })

  it('marks only the focused agent row', async () => {
    mockAgentActivityDisplayMode = 'full'
    mockFocusedAgentPaneKey = 'tab-1:2'
    mockAgents = [mockAgent({ paneKey: 'tab-1:1' }), mockAgent({ paneKey: 'tab-1:2' })]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('data-focused="false"')
    expect(markup).toContain('data-pane-key="tab-1:1"')
    expect(markup).toContain('data-focused="true"')
    expect(markup).toContain('data-pane-key="tab-1:2"')
  })

  it('collapses orchestration child agent rows behind a parent disclosure by default', async () => {
    mockAgentActivityDisplayMode = 'full'
    mockAgents = [
      mockAgent({
        paneKey: 'tab-parent:1',
        lineage: {
          depth: 0,
          isFirstSibling: true,
          isLastSibling: true,
          childCount: 1
        }
      }),
      mockAgent({
        paneKey: 'tab-child:1',
        state: 'done',
        stateStartedAt: 1500,
        orchestration: { parentPaneKey: 'tab-parent:1' },
        lineage: {
          depth: 1,
          isFirstSibling: true,
          isLastSibling: true,
          childCount: 0
        }
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="tree"')
    expect(markup).toContain('data-pane-key="tab-parent:1"')
    expect(markup).not.toContain('data-pane-key="tab-child:1"')
    expect(markup).toContain('aria-label="Show 1 child agent"')
    expect(markup).toContain('aria-expanded="false"')
  })

  it('keeps partially cyclic orchestration rows visible as flat roots', async () => {
    mockAgentActivityDisplayMode = 'full'
    mockAgents = [
      mockAgent({ paneKey: 'tab-root:1' }),
      mockAgent({
        paneKey: 'tab-cycle-a:1',
        stateStartedAt: 1200,
        orchestration: { parentPaneKey: 'tab-cycle-b:1' },
        lineage: {
          depth: 0,
          isFirstSibling: true,
          isLastSibling: false,
          childCount: 1
        }
      }),
      mockAgent({
        paneKey: 'tab-cycle-b:1',
        state: 'done',
        stateStartedAt: 1300,
        orchestration: { parentPaneKey: 'tab-cycle-a:1' },
        lineage: {
          depth: 1,
          isFirstSibling: false,
          isLastSibling: true,
          childCount: 1
        }
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('data-pane-key="tab-root:1"')
    expect(markup).toContain('data-pane-key="tab-cycle-a:1"')
    expect(markup).toContain('data-pane-key="tab-cycle-b:1"')
    expect(markup).not.toContain('aria-label="Show 1 child agent"')
  })

  it('does not render the labeled wrapper when there are no agent rows', async () => {
    mockAgents = []
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toBe('')
  })

  it('only wires terminal popovers when enabled, live, and the pane key matches the tab', async () => {
    const leafId = '44444444-4444-4444-8444-444444444444'
    mockAgentActivityDisplayMode = 'full'
    mockExperimentalAgentTerminalPopover = true
    mockLiveTabIds = ['tab-1', 'tab-other', 'legacy']
    mockTerminalLayoutsByTabId = {
      'tab-1': mockLayoutForLeaf(leafId)
    }
    mockAgents = [
      mockAgent({ paneKey: `tab-1:${leafId}`, tabId: 'tab-1' }),
      mockAgent({ paneKey: 'tab-2:1', tabId: 'tab-other' }),
      mockAgent({ paneKey: 'legacy', tabId: 'legacy' }),
      mockAgent({ paneKey: 'tab-stale:1', tabId: 'tab-stale', state: 'done' })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain(`data-pane-key="tab-1:${leafId}" data-popover="true"`)
    expect(markup).toContain('data-pane-key="tab-2:1" data-popover="false"')
    expect(markup).toContain('data-pane-key="legacy" data-popover="false"')
    expect(markup).toContain('data-pane-key="tab-stale:1" data-popover="false"')
  })

  it('does not wire terminal popovers for missing split leaves in a live tab', async () => {
    const liveLeafId = '55555555-5555-4555-8555-555555555555'
    const removedLeafId = '66666666-6666-4666-8666-666666666666'
    mockAgentActivityDisplayMode = 'full'
    mockExperimentalAgentTerminalPopover = true
    mockLiveTabIds = ['tab-1']
    mockTerminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf', leafId: liveLeafId },
        activeLeafId: liveLeafId,
        expandedLeafId: null
      }
    }
    mockAgents = [
      mockAgent({ paneKey: `tab-1:${liveLeafId}`, tabId: 'tab-1' }),
      mockAgent({ paneKey: `tab-1:${removedLeafId}`, tabId: 'tab-1', state: 'done' })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain(`data-pane-key="tab-1:${liveLeafId}" data-popover="true"`)
    expect(markup).toContain(`data-pane-key="tab-1:${removedLeafId}" data-popover="false"`)
  })

  it('wires terminal popovers to compact agent rows when compact mode is active', async () => {
    const leafId = '55555555-5555-4555-8555-555555555555'
    mockAgentActivityDisplayMode = 'compact'
    mockExperimentalAgentTerminalPopover = true
    mockTerminalLayoutsByTabId = {
      'tab-1': mockLayoutForLeaf(leafId)
    }
    mockAgents = [
      mockAgent({
        paneKey: `tab-1:${leafId}`,
        tabId: 'tab-1',
        agentType: 'codex',
        prompt: 'Run tests'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('group/compact-agent-row')
    expect(markup).toContain('data-agent-terminal-popover-row=""')
    expect(markup).toContain('Run tests')
  })

  it('keeps compact rows visible instead of an aggregate summary when terminal popovers are enabled', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockExperimentalAgentTerminalPopover = true
    mockTerminalLayoutsByTabId = {
      'tab-1': {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: '66666666-6666-4666-8666-666666666666' },
          second: { type: 'leaf', leafId: '77777777-7777-4777-8777-777777777777' }
        },
        activeLeafId: '66666666-6666-4666-8666-666666666666',
        expandedLeafId: null
      }
    }
    mockAgents = [
      mockAgent({
        paneKey: 'tab-1:66666666-6666-4666-8666-666666666666',
        agentType: 'codex',
        state: 'done',
        startedAt: 1000,
        prompt: 'First agent'
      }),
      mockAgent({
        paneKey: 'tab-1:77777777-7777-4777-8777-777777777777',
        agentType: 'claude',
        state: 'done',
        startedAt: 1500,
        prompt: 'Second agent'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).not.toContain('All 2 agents done')
    expect(markup).toContain('First agent')
    expect(markup).toContain('Second agent')
    expect(markup.match(/data-agent-terminal-popover-row=""/g)).toHaveLength(2)
  })

  it('renders a compact summary affordance for two flat agents', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({ agentType: 'codex', state: 'done', startedAt: 1000, prompt: 'First agent' }),
      mockAgent({
        paneKey: 'tab-1:2',
        agentType: 'claude',
        state: 'done',
        startedAt: 1500,
        prompt: 'Second agent'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('All 2 agents done')
    expect(markup).toContain('Expand All 2 agents done')
    expect(markup).not.toContain('First agent')
    expect(markup).not.toContain('Second agent')
    expect(markup).not.toContain('data-testid="agent-row"')
  })

  it('renders compact agent messages with images as inline thumbnails', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        state: 'done',
        startedAt: 1000,
        prompt: 'Check screenshot',
        lastAssistantMessage: 'Result:\n\n![Image #1](data:image/png;base64,abc123)'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('group/compact-agent-row')
    expect(markup).toContain('<img')
    expect(markup).toContain('alt="Image #1"')
    expect(markup).toContain('max-h-36')
    expect(markup).not.toContain('data-testid="agent-row"')
  })

  it('bounds long compact agent messages that include image markdown', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        state: 'done',
        startedAt: 1000,
        prompt: 'Check screenshot',
        lastAssistantMessage: `${'Detailed result. '.repeat(400)}\n\n![Image #1](https://example.com/screenshot.png)`
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('max-h-36')
    expect(markup).toContain('overflow-hidden')
    expect(markup).not.toContain('<img')
    expect(markup).toContain('href="https://example.com/screenshot.png"')
  })

  it('renders a compact summary affordance for multiple flat agents', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        state: 'waiting',
        startedAt: 1000,
        prompt: 'Pick a layout'
      }),
      mockAgent({
        paneKey: 'tab-1:2',
        agentType: 'claude',
        startedAt: 1500,
        stateStartedAt: 1500,
        prompt: 'Run tests'
      }),
      mockAgent({
        paneKey: 'tab-1:3',
        agentType: 'gemini',
        state: 'done',
        startedAt: 1700,
        stateStartedAt: 1700,
        prompt: 'Review spacing'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('items-center gap-0.5')
    expect(markup).not.toContain('-space-x-1')
    expect(markup).toContain('3 agents: 1 waiting, 1 working, 1 done')
    expect(markup).toContain('Expand 3 agents: 1 waiting, 1 working, 1 done')
    expect(markup).not.toContain('data-testid="agent-row"')
  })

  it('avoids repeating the total when every compact summary agent has the same state', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({ agentType: 'codex', state: 'done', startedAt: 1000, prompt: 'One' }),
      mockAgent({
        paneKey: 'tab-1:2',
        agentType: 'claude',
        state: 'done',
        startedAt: 1500,
        prompt: 'Two'
      }),
      mockAgent({
        paneKey: 'tab-1:3',
        agentType: 'gemini',
        state: 'done',
        startedAt: 1700,
        prompt: 'Three'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('All 3 agents done')
    expect(markup).toContain('Expand All 3 agents done')
    expect(markup).not.toContain('3 agents: 3 done')
    expect(markup).not.toContain('>+3<')
  })

  it('prioritizes agent varieties in compact summary icons', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      ['tab-1:1', 'codex', 'One'],
      ['tab-1:2', 'codex', 'Two'],
      ['tab-1:3', 'codex', 'Three'],
      ['tab-1:4', 'gemini', 'Four'],
      ['tab-1:5', 'claude', 'Five']
    ].map(([paneKey, agentType, prompt]) =>
      mockAgent({ paneKey, agentType, startedAt: 1000, prompt })
    )
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    const iconTitles = [...markup.matchAll(/title="([^"]+)"/g)].map((match) => match[1])

    expect(iconTitles).toEqual(['Codex', 'Gemini', 'Claude'])
    expect(markup).toContain('>+2<')
  })

  it('summarizes compact lineage by parent rows before revealing children', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        paneKey: 'tab-parent-a:1',
        agentType: 'codex',
        startedAt: 1000,
        prompt: 'Parent A'
      }),
      mockAgent({
        paneKey: 'tab-child-a:1',
        agentType: 'claude',
        state: 'done',
        startedAt: 1100,
        stateStartedAt: 1100,
        prompt: 'Child A',
        orchestration: { parentPaneKey: 'tab-parent-a:1' }
      }),
      mockAgent({
        paneKey: 'tab-parent-b:1',
        agentType: 'gemini',
        state: 'waiting',
        startedAt: 1200,
        stateStartedAt: 1200,
        prompt: 'Parent B'
      }),
      mockAgent({
        paneKey: 'tab-child-b:1',
        agentType: 'codex',
        startedAt: 1300,
        stateStartedAt: 1300,
        prompt: 'Child B',
        orchestration: { parentPaneKey: 'tab-parent-b:1' }
      }),
      mockAgent({
        paneKey: 'tab-parent-c:1',
        agentType: 'codex',
        state: 'done',
        startedAt: 1400,
        stateStartedAt: 1400,
        prompt: 'Parent C'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="tree"')
    expect(markup).toContain('3 parents: 1 waiting, 1 working, 1 done')
    expect(markup).not.toContain('Parent A')
    expect(markup).not.toContain('Child A')
  })
})
