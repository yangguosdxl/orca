# Host Context Implementation Checklist

This checklist tracks the remaining work needed to make Hosts first-class across projects, tasks, automations, SSH, remote servers, and future cloud VMs.

The target model is:

- **Project** is the durable logical project.
- **Project host setup** means that project exists on a specific host at a specific path.
- **Task source context** means which host/account/provider is used to fetch or mutate external work items.
- **Run host** means where a workspace, agent, automation, terminal, clone, or command executes.
- Source context and run host are explicit, may differ, and should not be inferred from ambient client state.

## Checklist Status

- [ ] Not started.
- [~] In progress or partially covered.
- [x] Complete and verified.

## 1. Shared Model And Naming

- [x] Add a shared TaskSourceContext type that captures provider, host/source target, logical project id, optional projectHostSetupId, and provider-specific identity such as owner/repo, GitLab project id, Linear workspace/team, or Jira site/project.
- [x] Add a shared run-target type or selector for RunHostContext / WorkspaceRunContext so workspace creation, agent launch, automations, and remote execution use the same vocabulary.
- [~] Audit user-facing copy so the product says **Host** for Local Mac, SSH hosts, remote servers, and future cloud VMs, while preserving technical labels only where useful.
- [x] Document the invariant that task source context and run host are separate choices.
- [~] Add compatibility adapters for existing repo-id/path-based callers so old data can be read while new code moves to explicit contexts.
- [x] Add schema migration notes for old automations, cached task selections, pending worktree requests, and any persisted task drawer state.

Done means: a new agent can read the shared types and understand exactly where work item data comes from versus where execution happens.

## 2. Provider Routing And Task Data

- [x] Update GitHub issue/PR listing to accept an explicit TaskSourceContext instead of deriving from selected repo, path, or active runtime state.
- [x] Update GitHub drawer mutations such as comment, state change, assignment, label, branch creation, and review actions to preserve the same source context as the list item.
- [x] Update GitHub cache keys to include provider identity and source host/runtime identity so two hosts with different GitHub accounts cannot collide.
- [x] Update GitLab IPC/preload/main handlers to accept explicit project/source context instead of path-only selectors.
- [x] Guard or retire GitLab path-only fallbacks where they can mutate or fetch from the wrong host.
- [x] Update Linear routing to use an explicit source account/workspace context instead of settings.activeRuntimeEnvironmentId.
- [x] Update Jira routing to use an explicit source account/site/project context instead of settings.activeRuntimeEnvironmentId.
- [~] Add provider diagnostics that show which host/account/site a task source is using.
- [~] Add error states for unavailable source hosts, missing provider auth, unsupported provider on host, and version-skewed remote servers.

Done means: if Machine A and Machine B have different provider accounts, every list and mutation goes through the user-selected source context.

## 3. Tasks UI

- [~] Add an explicit source-context picker or display for Tasks that can represent host, provider account, and project/source.
- [~] Decide and implement the default Tasks view when a logical project exists on multiple hosts.
- [~] Support switching the task source without changing the current run host.
- [~] Show enough account/host metadata to make mismatched GitHub/GitLab/Linear/Jira accounts understandable.
- [~] Persist task source context in task drawer URLs/state so refresh, deep links, and reopen preserve the same source.
- [x] Ensure task drawer actions reuse the drawer item source context, not a global provider default.
- [x] Add disabled/auth-needed/disconnected states for source hosts.
- [x] Add empty states explaining when a project has no configured task source on the selected host.

Done means: users can tell where Tasks are being fetched from, and changing execution host does not silently change provider data.

## 4. New Workspace Modal, Start Work, And Workspace Creation

- [x] Split “start from task/issue/PR” source context from workspace run target in New Workspace modal state.
- [~] When opening the New Workspace modal from Tasks, preselect the logical project and a reasonable run host without treating the source repo as the only execution target.
- [x] Ensure pending worktree/workspace creation persists both the source task context and selected run host.
- [x] Make “create workspace on host” only show hosts where the project has a ProjectHostSetup.
- [x] Keep “add project to host” as the path for making a project available on another host; do not present workspace creation as if Orca is responsible for bootstrapping repos/dependencies.
- [x] Update clone/browse/create project flows so selected host is not repeated as a fake editable SSH field.
- [x] Ensure clone destination defaults are human and host-appropriate, and allow changing the clone location where the host supports it.
- [x] Improve clone error messages for existing destination paths with the actual path and next action.
- [~] Ensure PR/MR base resolution uses source context for provider data and run host context for local/remote git commands.

Done means: starting work from an external item carries the item’s source identity separately from where the agent will run.

## 5. Automations

- [~] Migrate Automation.projectId away from repo-id semantics toward logical project id plus explicit run host/project host setup.
- [x] Store automation source context separately from automation run context.
- [x] Snapshot source context and run context on each automation run for auditability and retry safety.
- [x] Update automation dispatch/precheck code to validate selected run host availability and project host setup.
- [x] Verify automation live lookups do not use ambient settings: current Orca automations do not fetch issue/PR/task lists during dispatch, and branch/base-ref lookup routes through the selected repo host.
- [x] Update session reuse logic so an automation never resumes on the wrong host.
- [~] Add disabled states for disconnected run host, missing project host setup, missing source auth, unavailable source tool, and unsupported provider.
- [x] Add migration behavior for old automations that only know a repo id/path.
- [x] Update CLI/RPC automation APIs with v2 selectors for logical project, source context, and run host.

Done means: scheduled or manual automations behave predictably when a project exists on multiple hosts or providers differ by host.

## 6. Settings, Accounts, And Host Ownership

- [~] Clarify which settings are client-owned versus host-owned.
- [~] Add host/account selectors to provider settings where credentials may differ by host.
- [~] Make provider rate limits, diagnostics, and “current account” views show their host/source context.
- [x] Audit source-control AI, agent defaults, command defaults, and model selections for whether they should be client-global or host-scoped.
- [x] Preserve existing Windows/WSL-style setting patterns where they already solve host-specific settings.
- [x] Ensure remote server version/capability information is visible enough to explain unavailable controls.

Done means: settings pages no longer imply one global provider/account when the action may be host-owned.

## 7. Cache, Request Ownership, And Runtime Compatibility

- [~] Audit caches keyed by repo id, path, owner/repo, or active runtime and add host/source identity where needed.
- [~] Ensure request ownership is explicit for provider fetches, provider mutations, file-system calls, git calls, terminal calls, and automation runs.
- [~] Add capability negotiation for remote servers so new clients can degrade gracefully with older servers.
- [x] Add version-skew UX for unsupported source-context or host-context APIs.
- [x] Ensure SSH hosts and remote servers expose comparable availability/health states to the UI.
- [x] Keep future cloud VM support as a host capability model, not a separate user-facing mental model.

Done means: no background request can accidentally use the wrong host because it fell back to global state.

## 8. Sidebar And Project Host UX

- [x] Verify sidebar only shows host entries for projects that actually exist on those hosts.
- [x] Verify disconnected hosts are visually disabled and not selectable when selection would fail.
- [x] Keep local-only users in the low-jarring path: no unnecessary host chrome when only one local host exists.
- [x] Preserve workspace drag/reorder behavior and host-section drag behavior after project-first host changes.
- [x] Verify collapsed/expanded host behavior is stable while dragging.
- [x] Ensure host labels, counts, and status indicators are visually calm and aligned with docs/STYLEGUIDE.md.

Done means: the sidebar reflects project availability, not every configured SSH target, and disconnected states are understandable.

## 9. CLI, Remote Server, SSH, And Cloud-Ready Host APIs

- [x] Add CLI selectors for logical project, project host setup, source host/context, and run host.
- [x] Keep SSH and remote server behavior represented as host capabilities rather than separate product concepts.
- [x] Ensure remote server mode can still support users who want the desktop client to behave like “the server” when explicitly configured.
- [x] Ensure SSH remains the lightweight “execute on this machine over SSH” path.
- [~] Ensure remote server remains the durable runtime path for web/mobile handoff, background work, and richer server-owned state.
- [x] Note cloud VM provisioning as future host onboarding/provisioning work, not a requirement for this PR.

Done means: Local, SSH, remote server, and future cloud VMs share one Host model while keeping their different capabilities clear.

## 10. Verification Matrix

- [x] Unit-test source-context serialization, cache keys, and provider routing.
- [x] Unit-test automation migration from repo-id/path-based records.
- [x] Unit-test workspace creation selectors for logical project plus host setup.
- [ ] Integration-test local project with local provider credentials.
- [x] Integration-test SSH project setup, clone/browse/create flows, and workspace creation.
- [x] Integration-test project available on local and SSH hosts, then create workspaces on each host.
- [x] Integration-test task source on Host A with workspace run on Host B.
- [ ] Integration-test two hosts with different GitHub accounts and verify issue/PR lists and mutations use the selected source.
- [ ] Integration-test GitLab where path-only selectors previously existed.
- [ ] Integration-test Linear/Jira with explicit source account selection.
- [~] Integration-test automations on local host, SSH host, and remote server where supported.
- [~] Integration-test disconnected host UX for Tasks, New Workspace modal, sidebar, and automations.
- [ ] Integration-test new client with older remote server and older client with newer server where practical.
- [~] Electron-test Add Project flows: browse folder, clone URL, and create project from scratch on local and SSH hosts.
- [~] Electron-test workspace options and sidebar host filtering.
- [~] Electron-test Tasks source picker/display and task drawer mutations.
- [~] Capture screenshots for all important UX states in a dark-background HTML report.

Done means: the test report demonstrates the complete user journey, including local, SSH, multi-host project, task source, automation, disconnected, and version-skew states.

## 11. Documentation And PR Evidence

- [x] Update the main design doc with source context versus run host boundaries.
- [x] Update PR description with exact completed scope and explicit out-of-scope items.
- [x] Link this checklist from the PR or implementation notes.
- [x] Keep evidence screenshots out of git and attach/report them through approved PR channels.
- [ ] Add plain-English release note copy for the Host model only after UX is verified.

Done means: reviewers and future agents can understand the vision, implementation state, verification evidence, and remaining risk without reconstructing this conversation.

## Implementation Log

- [x] 2026-06-12: Added shared TaskSourceContext and WorkspaceRunContext types, normalization helpers, cache-scope helpers, and unit coverage.
- [x] 2026-06-12: Added automation source/run context fields and snapshots on AutomationRun creation while preserving legacy repo-id projectId behavior.
- [x] 2026-06-12: Let Linear and Jira runtime clients accept TaskSourceContext while keeping legacy activeRuntimeEnvironmentId callers working.
- [x] 2026-06-12: Let GitHub work-item fetch accept an explicit GitHub TaskSourceContext for runtime routing and host-scoped cache ownership.
- [x] 2026-06-12: Persisted taskSourceContext in New Workspace draft state for linked GitHub work items.
- [x] 2026-06-12: Added automation CLI project/host/project-host-setup target resolution and runtime RPC context pass-through.
- [x] 2026-06-12: Added GitLab repoId/sourceContext support to preload and main IPC handlers with source-host validation.
- [x] 2026-06-12: Verified with focused Vitest coverage for shared context, persistence automations, GitHub work-item routing, CLI automation routing, runtime automation RPC, plus full pnpm run typecheck.
- [x] 2026-06-12: Wired TaskPage GitLab lists/todos and GitLabItemDialog detail/mutation calls through repoId/sourceContext, then verified web/node/full typechecks plus focused shared/GitLab/GitHub/automation/persistence/CLI tests.
- [x] 2026-06-12: Wired GitHubItemDialog repo-scoped details/comments/review comments/viewed state/reviewer requests/PR actions/check refreshes/issue metadata edits through sourceContext, added a GitHub IPC host-mismatch regression test, and verified GitHub-focused tests plus full typecheck.
- [x] 2026-06-12: Updated GitHub work-item cache keys to preserve full task source scope, including provider identity, and added regression coverage for two GitHub identities on the same host.
- [x] 2026-06-12: Added taskSourceContext to the New Workspace modal handoff and seeded it from GitHub/GitLab Tasks so start-work source identity survives independent of run-host selection.
- [x] 2026-06-12: Updated TaskPage cached work-item reads/selectors to use the same GitHub source cache scope as fetches, preventing source-scoped fetches from disappearing from the cached UI path.
- [x] 2026-06-12: Added automation run-target validation before dispatch/precheck so missing, stale, or non-ready project host setups are skipped with clear errors instead of launching on the wrong host; verified with automation service tests, focused persistence tests, and full typecheck.
- [x] 2026-06-12: Updated renderer automation dispatch to create new workspaces from the stored run-context repo and reject existing-workspace dispatches whose workspace repo does not match the run host target; verified with web and full typecheck.
- [x] 2026-06-12: Updated Automations list/detail/edit read paths to prefer the saved run-context repo, so multi-host automations reopen and display against their selected host instead of the legacy projectId repo; verified with web typecheck.
- [x] 2026-06-12: Added a Tasks source-context summary chip showing provider plus host/account/project context for GitHub, GitLab, Linear, and Jira; verified with focused summary tests and web typecheck.
- [x] 2026-06-12: Verified New Workspace host selection only renders ready project-host setup options and ignores non-ready selections; covered by project-host setup option and combobox tests.
- [x] 2026-06-12: Verified Add Project clone/browse/create flows keep the selected host as context instead of a redundant SSH selector, preserve editable host-appropriate clone destinations, and now convert existing-destination clone failures into path-aware next-action copy; verified with Add Project UI and clone failure tests.
- [x] 2026-06-12: Verified workspace creation selectors resolve logical project plus focused host/project-host setup targets, including explicit setup IDs and unavailable setups; covered by project-host workspace target and project option tests.
- [x] 2026-06-12: Scoped GitHub Project view cache and in-flight request keys by local/runtime source scope, and scoped Project view wrapper cache lookups/view-list state accordingly; verified with a runtime-vs-local cache regression test and web typecheck.
- [x] 2026-06-12: Added SSH source-host availability to the Tasks source summary so disconnected, reconnecting, and auth-needed source hosts are visible without changing the run-host selection; verified with focused summary tests and web typecheck.
- [x] 2026-06-12: Preserved GitHub task detail source context in Tasks open payloads, back/forward history entries, and replay state so a reopened detail does not fall back to ambient host selection; added a same-item/different-source-host history regression and verified with UI/history slice tests plus web typecheck.
- [x] 2026-06-12: Updated GitHub Tasks warm prefetch to accept and forward TaskSourceContext so direct task-detail opens warm the same source-scoped cache that the mounted page reads; verified with UI slice and GitHub source/cache-focused tests plus web typecheck.
- [x] 2026-06-12: Added Automations run-target availability checks for manual runs, disabling/explaining Run Now when the project/workspace is missing, the saved run context no longer matches the host setup, the host is an unsupported runtime target, or the SSH host is disconnected/auth-needed/connecting; verified with focused availability tests and web typecheck.
- [x] 2026-06-12: Threaded repoId through hosted-review creation eligibility and creation so PR creation validates the exact project host setup instead of falling back to path-only repo lookup; added a main-process repoId/path mismatch regression and verified hosted-review IPC/store tests plus full typecheck.
- [x] 2026-06-12: Added Linear/Jira Settings account-scope diagnostics showing whether provider credentials and account checks are owned by the local desktop client or the selected remote server; verified with provider account-scope tests and web typecheck.
- [x] 2026-06-12: Added repo-backed Tasks empty-state copy that distinguishes missing project sources from no matching GitHub/GitLab work, then verified with focused empty-state tests and web typecheck.
- [x] 2026-06-12: Fed Tasks source-context diagnostics from the shared execution-host registry so the source chip now reports SSH availability and blocked/incompatible remote-server hosts; verified with summary tests and web typecheck.
- [x] 2026-06-12: Extended Linear/Jira Tasks source diagnostics to include the account-owning host plus blocked remote-server availability, keeping account source separate from workspace run host; verified with summary tests and web typecheck.
- [x] 2026-06-12: Started the user-facing Host copy audit by replacing stale “remote project” and “Remote SSH” UI labels with project-on-host / SSH-host language; verified with web typecheck.
- [x] 2026-06-12: Re-ran the broader focused host-context suite covering source summaries, empty states, execution-host registry, project-host setup options/combobox, settings setup options, and automation target availability; 7 files / 34 tests passed plus full pnpm run typecheck.
- [x] 2026-06-12: Added a safer automatic Tasks repo default that selects one source per logical GitHub project, preferring local when the same project exists on multiple hosts while preserving explicit/manual multi-host selection; verified with default-selection tests and web typecheck.
- [x] 2026-06-12: Fixed logical project projection for legacy repos whose GitHub `upstream` was missing by using repo-icon GitHub slug metadata as a provider-identity fallback; verified with `project-host-setup-projection.test.ts`.
- [x] 2026-06-12: Repaired worktree discovery/backfill so existing workspace metadata upgrades from legacy repo-scoped project IDs to provider-backed logical project IDs when the project-host setup is the same, including SSH metadata fallback rows while preserving cached display/activity/sparse metadata; verified with `worktrees.test.ts` and full `pnpm run typecheck`.
- [x] 2026-06-12: Re-verified the live Electron/SSH scenario after relaunch: one logical GitHub project has local and SSH project-host setups, stale SSH main-worktree metadata repairs to `github:stablyai/orca`, a workspace can be created on SSH, and another workspace can be created on Local Mac from the same project; screenshots saved under `notes/artifacts/`.
- [x] 2026-06-12: Verified disconnected SSH metadata fallback in Electron: SSH worktrees remain visible from persisted metadata with repaired logical project ownership, the status area reports `SSH Disconnected`, the user sees a reconnect dialog, and project create controls are disabled while disconnected; screenshot saved under `notes/artifacts/host-context-disconnected-ssh-metadata-fallback.png`.
- [x] 2026-06-12: Verified Add Project on SSH through the real Electron UI: selected an SSH host once, confirmed browse/clone/create screens do not show a redundant SSH-target field, cloned a throwaway Git repo into `/home/orca/add-project-clones`, and created a new Git project in `/home/orca/add-project-created`; verified remote filesystem and Orca project-host setup state.
- [x] 2026-06-12: Cleaned Add Project copy from stale “server folder/filesystem/path” wording to host-language where the UI applies to SSH, remote server, and future cloud hosts; verified with focused AddRepo tests, typecheck, and live screenshot `notes/artifacts/host-context-add-project-ssh-create-screen-host-copy.png`.
- [x] 2026-06-12: Refreshed `notes/multihost-remote-verification-report.html` with the current dark-background evidence set for logical project repair, New Workspace host selection, disconnected SSH fallback, SSH clone, SSH create project, and sidebar state after Add Project flows.
- [x] 2026-06-12: Fixed Tasks React maximum-depth crashes by making repo-owner runtime settings selectors shallow-stable and preventing same-key GitHub slug metadata hooks from writing no-op cached/loading state; verified with a focused hook regression, `repo-runtime-owner.test.ts`, full typecheck, and live Electron Tasks rendering.
- [x] 2026-06-12: Fixed New Workspace `Run on` switching so changing project-host setup inside the same logical project preserves the selected GitHub/GitLab task source instead of degrading to plain text; verified live by starting from GitHub issue `#5200`, switching run host from Local Mac to SSH, and confirming the issue card remained selected.
- [x] 2026-06-12: Created a task-started SSH workspace from the live Tasks page at `/home/orca/task-ssh-source-local-163115`; verified the remote worktree exists and the sidebar shows `Linked issue #5200`, with screenshots added to `notes/multihost-remote-verification-report.html`.
- [x] 2026-06-12: Verified Automations with SSH connected but Hermes unavailable on the remote PATH; changed the UI from misleading `Connect SSH` copy to `Source unavailable` plus `Retry source`, and captured the corrected state in the dark-background report.
- [x] 2026-06-12: Verified repo-backed Tasks empty-state copy for no selected project sources with `task-page-empty-state.test.ts`, covering the user-facing fallback when no host/account source is available for GitHub/GitLab work.
- [x] 2026-06-12: Updated `notes/project-first-host-model.md` with the explicit `TaskSourceContext` versus `WorkspaceRunContext` boundary, current task/automation implementation status, and remaining verification gaps; this checklist remains the detailed implementation tracker linked from the design-doc evidence set.
- [x] 2026-06-12: Continued the Host copy audit by replacing the remaining English Add Project/sidebar “remote project” and “Remote SSH” labels with project-on-SSH-host / SSH-host wording, then verified focused Add Project tests and full `pnpm run typecheck`; non-English locale placeholders still need the normal localization bootstrap pass.
- [x] 2026-06-12: Re-verified the New Workspace run-host path only exposes ready project-host setups, so hosts where the project does not exist are not selectable from workspace creation; covered by `ProjectHostSetupCombobox`, `project-host-setup-options`, and `project-host-workspace-target` tests.
- [x] 2026-06-12: Re-ran focused sidebar host tests: host headers are suppressed when only one host has visible workspaces, registered-but-empty/disconnected hosts do not create sidebar sections, SSH connection status flows to host headers, and drag mode can temporarily collapse host sections without mutating persisted collapse state; 8 sidebar files / 146 tests passed.
- [x] 2026-06-12: Tightened Add Project host selection so disconnected/error/blocked hosts stay visible but disabled instead of being selectable; verified with focused Add Project host selector/start tests and full `pnpm run typecheck`.
- [x] 2026-06-12: Added `CreateFromPicker` host-routing regression coverage for Automations branch/base-ref lookup, proving runtime-owned repos query their owner runtime and explicit local repos stay local even when another runtime is focused; verified alongside persistence and automation service tests.
- [x] 2026-06-12: Tightened the project-first design doc so host-aware Add Project is the current path for browse/import, clone, and create, while bulk setup and cloud VM provisioning are future host-onboarding work. Re-verified shared host-model tests covering local/SSH/runtime host kinds, runtime capability gating, SSH reconnect/disconnect actions, host settings overrides, and task source host scopes.
- [x] 2026-06-12: Live-verified Add Project disconnected-host UX in Electron by simulating the SSH target as disconnected in renderer state: the Host picker defaulted to Local Mac and showed the SSH host as a disabled muted row; restored SSH to connected and added screenshot evidence to `notes/multihost-remote-verification-report.html`.
- [x] 2026-06-12: Audited Settings ownership for Source Control AI defaults, repository Source Control AI overrides, agent launch defaults, quick commands, workspace directories, and provider accounts; added a tested settings-ownership helper and surfaced the ownership language in Settings while preserving the existing Windows/WSL account and agent-location pattern. Verified with focused settings tests and web typecheck.
- [x] 2026-06-12: Improved remote-server Settings version-skew diagnostics by showing the exact compatibility explanation plus named runtime capabilities instead of only a capability count; verified with `RuntimeEnvironmentsPane` tests and web typecheck.
- [x] 2026-06-12: Polished sidebar host headers from card-like rows into quieter sidebar grouping rows while keeping explicit SSH/status/count text; verified with focused sidebar tests, web typecheck, and live Electron screenshot `notes/artifacts/host-context-sidebar-calm-host-headers.png`.
- [x] 2026-06-12: Added a narrow `.gitignore` rule for `notes/artifacts/` so verification screenshots stay local while the HTML report can reference them; verified with `git check-ignore`.
- [x] 2026-06-12: Added `taskSourceContext` and `workspaceRunContext` to retryable pending worktree creation requests, seeded them from the Composer's selected task source and project-host setup, and verified the pending store preserves both identities with focused worktree tests plus web typecheck.
- [x] 2026-06-12: Preserved Jira task detail source context in Tasks open payloads, back/forward history entries, and replay state so a reopened Jira issue does not fall back to the ambient site/host; added a same-issue/different-source-host history regression and verified focused UI/history/feature-interaction tests, oxlint, and full `pnpm run typecheck`.
- [x] 2026-06-12: Scoped Jira optimistic detail patches to the selected `TaskSourceContext` so a same-key issue cached from another Jira host/site is not visually mutated; verified with `jira.test.ts`, focused oxlint, and full `pnpm run typecheck`.
- [x] 2026-06-12: Updated Composer GitHub PR and GitLab MR base-resolution to run against the selected workspace run repo instead of the provider item's source repo, preserving task source identity separately from run-host git commands; verified with a host-context boundary test, focused oxlint, and full `pnpm run typecheck`.
- [x] 2026-06-12: Added Jira provider-depth interaction recording when starting workspace creation from a Jira issue, matching GitHub/GitLab/Linear task-provider behavior; verified with the feature-interaction writer-boundary test and focused oxlint.
- [x] 2026-06-12: Scoped Linear optimistic issue patches to the selected `TaskSourceContext` so same-id issues cached from another Linear host/workspace are not visually mutated; threaded source context through Linear drawer/project edits and verified with `linear.test.ts`, focused oxlint, and full `pnpm run typecheck`.
- [x] 2026-06-12: Scoped GitHub optimistic work-item patches to the selected `TaskSourceContext` so identical repo/item ids from another GitHub host/account are not visually mutated; threaded source context through Tasks row edits and GitHub item drawer edits, then verified with `github.test.ts`, focused oxlint, full `pnpm run typecheck`, and `git diff --check`.
- [x] 2026-06-12: Threaded GitHub Tasks row-level mutations through `TaskSourceContext` for issue state, assignees, reviewer requests/removals, PR merge/auto-merge, and new issue creation/follow-up reads; verified with focused GitHub/TaskPage tests, focused oxlint, `pnpm run typecheck`, and `git diff --check`.
- [x] 2026-06-12: Added provider account-scope diagnostics to GitHub/GitLab CLI integration cards so code-host credential checks show whether they belong to the local desktop client or selected remote server, matching the existing Linear/Jira ownership copy; verified with focused integration-card scope tests and oxlint.
- [x] 2026-06-12: Extended task-detail navigation state to GitLab and fixed Linear replay so saved `TaskSourceContext` is restored through back/forward and direct detail reopens; GitLab detail history keys now include source scope so identical MRs from different hosts stay distinct. Verified with focused UI/history/static-boundary tests and oxlint.
- [x] 2026-06-12: Added host-scoped budget diagnostics to the GitHub and GitLab API Budget settings panels so rate-limit views explicitly say whether they are fetched from the local desktop CLI or selected remote-server CLI; verified with focused provider scope/panel render tests and oxlint.
- [x] 2026-06-12: Updated PR #5071 with the current verified scope, evidence docs, validation commands, explicit out-of-scope cloud/onboarding items, and remaining provider/version-skew risk.
- [x] 2026-06-12: Added load-time backfill for legacy automations and automation runs that predate `runContext`/`sourceContext`, deriving explicit project host and provider source contexts from the saved repo id/path; verified with focused persistence migration coverage, automation service/precheck tests, daemon/settings merge-repair tests, and full `pnpm run typecheck`.
- [x] 2026-06-12: Repaired the merge-repair lint gate without disabling max-lines by extracting automation run-target/usage modules and settings subcomponents, fixed stale source-context hook dependencies, and tightened GitHub PR checks cache ownership so `noCache` bypasses cache/in-flight requests while head-specific checks are reused during refresh events; verified targeted oxlint, focused automation/settings/GitHub cache tests (10 files / 157 tests), `github-checks-cache.test.ts`, `git diff --check`, and full `pnpm run typecheck`.
- [x] 2026-06-12: Preserved the explicit remote-server focus path as Settings → Active Server, with copy explaining that selecting a saved server makes it the default Host for server-routed projects, files, terminals, provider accounts, and browser/mobile handoff rather than introducing a separate Focused Host Mode; verified with `RuntimeEnvironmentsPane.test.ts`.
- [x] 2026-06-12: Added persisted context migration notes to `notes/project-first-host-model.md` covering old automations/runs, legacy `Automation.projectId`, cached task selections, retryable pending workspace creation requests, and task drawer/navigation replay state.
- [x] 2026-06-12: Completed source-context unit coverage by adding GitLab/Linear/Jira provider identity cache-scope serialization tests and rerunning shared source-context, GitHub source/cache routing, UI open-task, and task-navigation history suites (6 files / 261 tests) plus targeted oxlint.
- [x] 2026-06-12: Reconciled Add Project host-selection tests with the disabled-host UX: disconnected SSH hosts and blocked runtime hosts remain visible but disabled, the hook falls back to Local Mac instead of selecting a disconnected SSH host, and selection handlers ignore unavailable hosts; verified Add Project host selector/selection/dialog, sidebar host options, and execution-host registry tests (5 files / 34 tests) plus targeted oxlint.
- [x] 2026-06-12: Re-verified project-first drag/reorder behavior across workspace manual order, drag units, workspace-board pointer drops, host-section order/rows, repo reorder host splitting, and project-header drag helpers; 9 files / 62 tests passed plus targeted oxlint.
- [x] 2026-06-12: Routed Linear and Jira Tasks reads, create flows, list/detail mutations, comments, metadata, and New Workspace handoff through explicit account-backed `TaskSourceContext` while preserving legacy focused-runtime cache keys for old callers; verified with Linear/Jira source-routing regressions, focused Linear/Jira slice tests (2 files / 48 tests), targeted oxlint, `git diff --check`, and full `pnpm run typecheck`.
- [x] 2026-06-12: Preserved Linear task detail source context in `openTaskPage` data, back/forward history entries, history de-dupe keys, and Linear warm prefetch so direct detail opens replay the same account/host source instead of recomputing from focused settings; verified with UI/history tests (2 files / 131 tests) and full `pnpm run typecheck`.
- [x] 2026-06-12: Scoped GitHub Tasks partial-failure retry ownership to the selected source cache scope instead of `repoPath`, so same-project/same-path multi-host failures cannot make the wrong source banner look in-flight; verified with `task-page-cache-selectors.test.ts`, targeted oxlint, and full `pnpm run typecheck`.
- [x] 2026-06-12: Routed GitHub issue reads, PR check reads/details, PR comments, review replies, and review-thread resolution through explicit `TaskSourceContext` in the store/preload/main IPC boundary, and source-scoped their comment/check caches; verified with GitHub slice regressions (106 tests), focused oxlint, `git diff --check`, and full `pnpm run typecheck`.
- [x] 2026-06-12: Guarded remaining GitLab path-only fallbacks by making `workItemByPath` use the same repoId/source-context selector as the rest of GitLab IPC, passing repoId from URL picker and right-sidebar GitLab review actions, and verifying source-host routing with GitLab IPC regressions plus focused oxlint and full `pnpm run typecheck`.
- [x] 2026-06-12: Guarded GitHub label and assignable-user metadata lookups with the same repo/source-context selector as task mutations, so drawer edit metadata cannot bypass source-host validation; verified with GitHub IPC regressions (17 tests), focused oxlint, and full `pnpm run typecheck`.
- [x] 2026-06-12: Continued the Host copy audit through onboarding, remote folder-add, attachment import, Settings SSH copy, and remote file browser catalog text; extracted `RepoStepNestedImportPanel` to keep the touched onboarding component under max-lines, and verified with stale-copy scans, focused onboarding/repos tests, focused oxlint, full `pnpm run typecheck`, and `git diff --check`.
- [x] 2026-06-12: Preserved explicit automation run-host context in CLI project selectors: `orca automations create/edit --project/--host` and `--project-host-setup` now send `WorkspaceRunContext` alongside the legacy repo selector, so scheduled runs retain logical project, host, setup, repo, and path identity. Verified with focused CLI regressions (108 tests), targeted oxlint, full `pnpm run typecheck`, and `git diff --check`.
- [x] 2026-06-12: Added an advanced automation CLI source selector via `--source-context <json|null>` for create/edit, normalizing the shared `TaskSourceContext` shape before RPC and allowing edit callers to clear the source context with `null`; verified with focused CLI regressions (111 tests), targeted oxlint, full `pnpm run typecheck`, and `git diff --check`.
- [x] 2026-06-12: Added a reusable Tasks source availability notice and wired unavailable source-host/account states into the Tasks source chrome, so disconnected/auth-needed/blocked hosts show an inline status, fully unavailable sources disable their icon, and partial multi-host failures remain selectable with warning copy; verified with focused source-summary tests, targeted oxlint, and full `pnpm run typecheck`.
- [x] 2026-06-12: Added explicit remote-runtime Host model capability names for project setup, task source context, and workspace run context, then surfaced a Settings saved-server summary that says whether Host model support is ready, unknown, or requires a server update for specific missing capabilities; verified with focused RuntimeEnvironmentsPane tests, targeted oxlint, and full `pnpm run typecheck`.
- [x] 2026-06-12: Continued the Host copy audit by replacing the SSH disconnected dialog's stale "remote repository" message with SSH-host wording; verified with a stale-copy scan, targeted oxlint, and full `pnpm run typecheck`.
