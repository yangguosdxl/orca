// @vitest-environment happy-dom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openModal: vi.fn(),
      activeModal: null,
      settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
      updateSettings: vi.fn()
    })
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: () => <button type="button">Agent picker</button>
}))

vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({
  default: () => <div data-testid="sparse-select" />
}))

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: ({
    branchesEnabled,
    repoBackedSourcesDisabled,
    onActiveSourceModeChange
  }: {
    branchesEnabled?: boolean
    repoBackedSourcesDisabled?: boolean
    onActiveSourceModeChange?: (mode: string) => void
  }) => (
    <>
      <input
        aria-label="workspace name"
        data-branches-enabled={branchesEnabled ? 'true' : 'false'}
        data-repo-backed-sources-disabled={repoBackedSourcesDisabled ? 'true' : 'false'}
      />
      <button
        type="button"
        data-testid="set-linear-mode"
        onClick={() => onActiveSourceModeChange?.('linear')}
      >
        Linear mode
      </button>
    </>
  )
}))

vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: ({
    options,
    value,
    onValueChange
  }: {
    options: NewWorkspaceProjectOption[]
    value: string | null
    onValueChange: (value: string) => void
  }) => (
    <div data-testid="project-combobox" data-value={value ?? ''}>
      {options.map((option) => (
        <button key={option.id} type="button" onClick={() => onValueChange(option.id)}>
          {option.displayName}
        </button>
      ))}
    </div>
  )
}))

const projectOptions: NewWorkspaceProjectOption[] = [
  {
    kind: 'project-group',
    id: 'project-group:platform',
    projectGroupId: 'platform',
    displayName: 'Platform',
    badgeColor: 'var(--muted-foreground)',
    detail: '/workspace/platform',
    parentPath: '/workspace/platform',
    connectionId: null
  }
]

const sourceOptions: NewWorkspaceProjectOption[] = [
  {
    kind: 'project',
    id: 'repo-a-project',
    projectId: 'repo-a-project',
    displayName: 'Repo A',
    badgeColor: '#111111',
    detail: 'org/repo-a'
  },
  {
    kind: 'project',
    id: 'repo-b-project',
    projectId: 'repo-b-project',
    displayName: 'Repo B',
    badgeColor: '#222222',
    detail: 'org/repo-b'
  }
]

function renderCard(
  overrides: Partial<React.ComponentProps<typeof NewWorkspaceComposerCard>> = {}
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <NewWorkspaceComposerCard
        quickAgent={null}
        onQuickAgentChange={() => {}}
        eligibleRepos={[]}
        repoId="repo-a"
        projectOptions={projectOptions}
        selectedProjectId="project-group:platform"
        selectedRepoIsGit
        onRepoChange={() => {}}
        onProjectChange={() => {}}
        primaryActionLabel="Create workspace"
        name=""
        onNameValueChange={() => {}}
        onSmartGitHubItemSelect={() => {}}
        onSmartGitLabItemSelect={() => {}}
        onSmartBranchSelect={() => {}}
        onSmartLinearIssueSelect={() => {}}
        smartNameSelection={null}
        onClearSmartNameSelection={() => {}}
        forkPushWarning={null}
        detectedAgentIds={null}
        onOpenAgentSettings={() => {}}
        advancedOpen={false}
        onToggleAdvanced={() => {}}
        createDisabled={false}
        projectError={null}
        creating={false}
        onCreate={() => {}}
        note=""
        onNoteChange={() => {}}
        setupConfig={null}
        requiresExplicitSetupChoice={false}
        setupDecision={null}
        onSetupDecisionChange={() => {}}
        shouldWaitForSetupCheck={false}
        resolvedSetupDecision={null}
        createError={null}
        selectedRepoConnectionId={null}
        selectedRepoSshStatus={null}
        selectedRepoRequiresConnection={false}
        selectedRepoConnectInProgress={false}
        onConnectSelectedRepo={async () => {}}
        canUseSparseCheckout={false}
        sparsePresets={[]}
        sparseSelectedPresetId={null}
        onSparseSelectPreset={() => {}}
        branchesEnabled={false}
        setupControlsEnabled={false}
        sparseControlsEnabled={false}
        {...overrides}
      />
    )
  })
  return { container, root }
}

let current: { container: HTMLDivElement; root: Root } | null = null

describe('NewWorkspaceComposerCard folder task source mode', () => {
  afterEach(() => {
    act(() => current?.root.unmount())
    current?.container.remove()
    current = null
  })

  it('shows a subordinate Task Source selector inside the create-from section', () => {
    current = renderCard({
      taskSourceProjectOptions: sourceOptions,
      selectedTaskSourceProjectId: 'repo-a-project',
      onTaskSourceProjectChange: vi.fn()
    })

    const projectSection = current.container.querySelector(
      '[data-contextual-tour-target="workspace-creation-project"]'
    )
    const nameSection = current.container.querySelector(
      '[data-contextual-tour-target="workspace-creation-name"]'
    )
    expect(projectSection?.textContent).not.toContain('Task Source')
    expect(nameSection?.textContent).toContain("Name or 'Create From'")
    expect(nameSection?.textContent).toContain('Task Source')
    expect(nameSection?.textContent).toContain('Repo A')
    expect(nameSection?.textContent).toContain('Repo B')
  })

  it('hides folder task-source controls when the smart name field switches to Linear mode', () => {
    current = renderCard({
      taskSourceProjectOptions: sourceOptions,
      selectedTaskSourceProjectId: 'repo-a-project',
      onTaskSourceProjectChange: vi.fn()
    })

    act(() => {
      current?.container
        .querySelector<HTMLButtonElement>('[data-testid="set-linear-mode"]')
        ?.click()
    })

    const nameSection = current.container.querySelector(
      '[data-contextual-tour-target="workspace-creation-name"]'
    )
    expect(nameSection?.textContent).not.toContain('Task Source')
    expect(current.container.querySelector('[aria-label="workspace name"]')).toBeTruthy()
  })

  it('does not disable folder workspace creation when only source lookup needs SSH', () => {
    current = renderCard({
      eligibleRepos: [
        { id: 'repo-a', displayName: 'Repo A', path: '/repo-a', connectionId: 'ssh-a' } as never
      ],
      taskSourceProjectOptions: sourceOptions,
      selectedTaskSourceProjectId: 'repo-a-project',
      sourceLookupRequiresConnection: true,
      sourceLookupConnectionId: 'ssh-a',
      sourceLookupSshStatus: 'disconnected',
      sourceLookupConnectInProgress: false,
      onConnectSourceLookupRepo: async () => {}
    })

    const createButton = [...current.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Create workspace')
    )
    expect(createButton).toBeTruthy()
    expect(createButton?.hasAttribute('disabled')).toBe(false)
    expect(
      current.container
        .querySelector('[aria-label="workspace name"]')
        ?.getAttribute('data-repo-backed-sources-disabled')
    ).toBe('true')
  })
})
