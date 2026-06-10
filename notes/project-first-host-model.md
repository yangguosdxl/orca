# Project-First Host Model

## Context

We have been exploring how Orca should make VMs, remote servers, SSH machines,
and future cloud-hosted compute feel first class.

The current implementation direction groups the workspace sidebar by execution
host:

```text
Local Mac
  Project A
    workspace-1
SSH / VM 1
  Project A
    workspace-2
```

That model is useful as an operational view, but it makes the machine feel like
the outermost user concept. After discussion, the stronger long-term product
model is project-first:

```text
Project A
  Local Mac
    workspace-1
  Cloud VM 1
    workspace-2
```

In this model, machines are not separate isolated workspaces. They are places
where a project can be available and where a workspace can run.

## Decision Summary

Move Orca toward a project-first durable model:

```text
Project -> ProjectHostSetup -> Workspace
```

The host-first sidebar work is still valuable as an operational view because it
makes remote status, filtering, and troubleshooting visible. It should not be
the only long-term mental model. A host is where a project can run; the project
is still the user's primary organizing concept.

This means:

- a local-only project remains simple: one project with one local setup
- an SSH target, VM, remote server, or future Orca cloud VM is a host
- a project can exist on one host, several hosts, or only a remote host
- same-name folders should not merge unless Orca has reliable provider/setup
  identity
- workspace creation eventually chooses both project and run-on host
- settings need clear client, host, project, and project-host ownership

The short implementation count is 12 meaningful change surfaces: data model,
persistence, runtime ownership, workspace creation, project setup, sidebar row
model, project settings, host settings, version compatibility, caches, CLI/API,
and validation.

## Reference Findings

### Superset

Superset is closest to the desired Orca model.

Its conceptual model is:

```text
Project + Host -> Workspace
```

Specific details:

- A project is the durable repo concept.
- A host is a registered machine that can run workspaces.
- A workspace stores both `projectId` and `hostId`.
- Workspace creation is explicitly host-targeted: pick a project, pick a host,
  then create the workspace on that host.
- The schema has a uniqueness rule for a "main" workspace per
  `(projectId, hostId)`, which means the same project can be materialized on
  multiple hosts.
- Project setup is host-scoped. A project can be cloned or imported on a
  specific host.
- The UI can block workspace creation with "Project not set up on this host."
- Project settings have host-aware pieces like project location and worktree
  location on the selected host.

This maps well to Orca because Orca already thinks in repos/projects,
worktrees, tasks, agents, and terminals.

### Cmux

Cmux is more workspace/session-first.

Its conceptual model is closer to:

```text
Workspace/session -> local or remote execution context
```

Specific details:

- `cmux ssh user@remote` creates a workspace for a remote machine.
- Remote/SSH is a property of the workspace/session.
- Browser panes can route through the remote network, so remote `localhost`
  works naturally.
- File explorer follows SSH workspaces and shows the remote root.
- Remote sessions have remote configuration and reconnect/persistence behavior.
- Cmux has project-specific command config, but it does not appear to center a
  durable "Project is available on hosts X/Y/Z" abstraction.

Cmux is a strong reference for SSH/session polish, but not the best reference
for Orca's project/worktree data model.

## Recommended Orca Model

The recommended durable model is:

```text
Project -> ProjectHostSetup -> Workspace
```

Where:

- `Project` is the durable repo identity.
- `ProjectHostSetup` means "this project is available on this host at this
  path, with this setup state and host-specific config."
- `Workspace` is a branch/task/worktree instance of a project on one host.

Potential names for `ProjectHostSetup`:

- `ProjectInstallation`
- `ProjectHostSetup`
- `ProjectLocation`
- `HostProject`

`ProjectHostSetup` is probably the clearest product/data term for now.

## Current Orca Model Inventory

Orca currently has pieces of the new model, but they are attached to the wrong
concepts for a project-first product.

### Repo Is Both Project And Host Setup

`Repo` currently represents the user's project in the UI, but it also owns
host-local setup fields:

- `path`
- `worktreeBasePath`
- `connectionId`
- `executionHostId`
- `hookSettings`
- `gitUsername`
- repo-specific source-control overrides

That means two checkouts of the same project on two machines become two repos,
even when the user thinks of them as one project.

In the project-first model:

- project identity should move to `Project`
- host-local checkout information should move to `ProjectHostSetup`
- compatibility can keep `Repo` as a transitional projection for old APIs

### Worktree Belongs To Repo Only

`Worktree` currently stores `repoId`, and the host is inferred from the owning
repo. This works when "repo" means "checkout on one host", but it is awkward
when one project can exist on several hosts.

In the project-first model, a workspace should know:

- `projectId`
- `hostId`
- the selected `projectHostSetupId`
- the worktree path on that host

The existing `repoId` can initially point at a compatibility setup id, but the
durable direction should be explicit.

### Persistence Stores Repos As The Durable Root

`PersistedState` currently stores `repos: Repo[]`, `projectGroups`, and
worktree metadata keyed around repo/worktree ids. Recent multi-host work also
stores per-host session partitions, which is good for runtime ownership, but it
does not create a durable "project is set up on host" record.

The migration should derive:

- one `Project` per existing user-visible project identity
- one `ProjectHostSetup` per existing `Repo`
- one `Host` from local, SSH, runtime, and future cloud targets
- existing worktrees attached to the setup derived from their current repo

For a local-only user this should be boring: every existing repo becomes a
project with one local setup.

### Renderer Store Is Repo-Centric

The renderer store has repo-first actions:

- `fetchRepos`
- `addRepoPath`
- `addRepo`
- `removeProject`
- `updateRepo`
- `fetchWorktrees(repoId)`
- `createWorktree(repoId, ...)`

Remote runtime support already chooses a target based on the active runtime or
repo owner, but the public shape is still repo-centric. A project-first API
needs calls like:

- `fetchProjects`
- `fetchProjectHostSetups(projectId)`
- `setupProjectOnHost(projectId, hostId, ...)`
- `createWorkspace({ projectId, hostId, ... })`

During migration, these can be implemented as wrappers around the current repo
APIs so the change is incremental.

### Add Project Means Add A Host-Local Checkout

Local `repos:add` and SSH `repos:addRemote` both persist a repo at a concrete
path. That path is the important host-local fact, but the UI labels the result
as a project.

In the new model, the add/setup flows split into three actions:

- create or import a durable project identity
- set up that project on a specific host
- create workspaces from any ready setup

### Runtime Ownership Is Already Pointing The Right Way

Terminals, sessions, remote PTYs, browser routing, and runtime RPC already have
host-aware pieces. The problem is that host ownership is inferred through repo
ownership rather than declared on the workspace/setup model.

The new model should preserve the current runtime routing discipline while
making host ownership explicit in the data model.

## Data Model Shape

### Project

Project-global state:

- id
- display name
- repo identity / provider metadata
- icon/color
- default branch
- Git provider linkage
- project-global settings

### Host

Host-global state:

- id
- kind: local, SSH, runtime, cloud VM
- label
- online/health/compatibility status
- platform/capabilities
- host-wide settings
- agent availability

### ProjectHostSetup

Host-specific project state:

- project id
- host id
- repo path on that host
- worktree base directory on that host
- setup state: not set up, setting up, ready, error, unsupported
- setup method: imported existing folder, cloned repo, provisioned by cloud
- platform/capability constraints
- host-specific project settings
- optional setup/teardown scripts

### Workspace

Workspace state:

- project id
- host id
- project host setup id, if we make that a real id
- branch/worktree name
- worktree path on the host
- task/PR/issue linkage
- agent/terminal/browser resources owned by that host

## UX Model

### Sidebar

Default sidebar should become project-first:

```text
Project A
  feature-login        Local Mac
  benchmark-fix        GPU VM

Project B
  auth-refactor        Work Linux
```

When a project has workspaces on multiple hosts, we can optionally show host
subgroups:

```text
Project A
  Local Mac
    feature-login
  GPU VM
    benchmark-fix
```

Rules:

- If a project only has one host represented, do not add noisy host nesting.
- If a project has multiple hosts, host subgroups can appear automatically.
- Host should remain available as a filter/view mode.
- The current host-first grouping can survive as an alternate operational view,
  but should not be the default mental model.

### Create Workspace

Workspace creation should ask:

1. Which project?
2. What branch/task/name?
3. Which host should run it?
4. If the project is not set up on that host, set it up inline or block with a
   clear action.

Example:

```text
Create workspace

Project: Orca
Branch: feature/remote-hosts
Run on: GPU VM 1

This project is not set up on GPU VM 1.
[Clone repo to host] [Import existing folder] [Cancel]
```

### Set Up Project On A Host

A project settings page should expose which hosts the project is available on:

```text
Project: Orca

Available on:
  Local Mac      Ready       /Users/me/orca
  GPU VM 1       Ready       /home/me/orca
  Work Linux     Not set up  [Set up]
```

Setup methods:

- clone from repo URL into a selected parent directory
- import an existing folder on the host
- future: provision cloud VM and clone automatically

### Add New Host / VM

Adding a host should not automatically attach every project to it.

After adding a host, Orca should offer:

```text
New host connected: GPU VM 1

Make projects available here:
  [ ] Orca         Clone to /home/me/orca
  [ ] Backend      Import existing folder
  [ ] ML Runner    Clone to /mnt/work/ml-runner
```

This is also the natural place for future cloud VM monetization:

1. provision host
2. choose projects to materialize there
3. create workspaces on that host

## Edge Cases

### Project Exists Only On One Host

This is normal. The project has one `ProjectHostSetup`.

The UI should not imply every project can run everywhere.

### Project Requires Linux Or Beefy Hardware

This is also normal. The project can mark local Mac as unsupported or simply not
set up. Create-workspace host choices should only show valid hosts by default,
with an affordance to reveal unavailable hosts and why they are unavailable.

### Work Projects Versus Personal Projects

Do not solve this with host grouping alone. This is better represented by:

- project ownership/account
- project tags/groups
- host availability
- workspace filters

### Existing Project On Computer A, Add To Computer B

Use "Set up project on host":

- clone from remote into a host path, or
- import an existing folder on the host.

### Add VM And Initialize Many Projects

Use a bulk "Make projects available on this host" flow. Each selected project
still needs a per-host location/method.

## What Needs To Change

This is a large model change. It is not just a sidebar reorder.

At a high level, 12 areas need to change.

### 1. Data Model

Add a first-class project-host setup record.

Current host ownership is mostly attached to repos/workspaces through
execution-host IDs. The new model needs a durable record for "project X is
available on host Y at path Z."

Concrete changes:

- add `Project`
- add `ProjectHostSetup`
- decide whether existing `Repo` becomes a compatibility projection, a renamed
  setup type, or is gradually replaced
- add selectors that answer "which setups exist for this project?" and "which
  host owns this workspace?"

### 2. Persistence And Migration

Existing repos/worktrees need to migrate into:

- project records
- host records
- project-host setup records
- workspace records tied to both project and host

For current local-only users, migration should feel invisible: each project gets
a local-host setup.

Concrete changes:

- bump schema version
- migrate every existing `Repo` into a `Project` plus one `ProjectHostSetup`
- preserve old repo ids or create an alias map so worktree metadata, terminal
  panes, caches, hooks, automations, and settings do not lose references
- keep downgrade behavior in mind because current persisted state is read by
  older builds

### 3. Sidebar Row Model

The sidebar should group primarily by project, not host.

Host grouping becomes nested under projects only when helpful, or becomes a
filter/view option.

Concrete changes:

- build sidebar rows from projects, setups, hosts, and workspaces
- show host labels inline for mixed-host projects without adding unnecessary
  nesting
- keep the host-first view/filter as an operational mode if it remains useful
- revisit drag/reorder so project order, host order within a project, and
  workspace order remain understandable

### 4. Workspace Creation

Create workspace needs a host picker that is constrained by project setup.

If the selected host does not have the project, the flow needs setup actions
instead of silently failing or creating an ambiguous remote workspace.

Concrete changes:

- change creation input from `repoId` to `{ projectId, hostId }`
- list ready setups first and unavailable hosts with clear reasons
- inline setup/import/clone when a project is not available on the chosen host
- ensure created workspaces persist explicit host/setup ownership

### 5. Project Setup / Add Project

Adding a project must distinguish:

- create a new project identity
- set up that project on this host
- set up an existing project on another host

This likely replaces a single "add repo" flow with a project-first setup flow.

Concrete changes:

- add "Set up on this host" flows for local paths, SSH paths, runtime hosts,
  and future cloud VMs
- support clone and import-existing-folder
- support bulk setup when a new host is added
- keep current add-repo flows as compatibility entry points during migration

### 6. Project Settings

Project settings need a host selector or host table for host-specific settings:

- repo location
- worktree base dir
- setup scripts
- branch prefix
- platform/capability notes

Project-global settings remain global.

Concrete changes:

- split settings into project-global and host-specific sections
- use a host dropdown/table for location, worktree base path, setup scripts, and
  platform constraints
- keep source-control and review settings provider-aware, not GitHub-only
- make the "which host am I editing?" answer explicit on every host-specific
  settings pane

### 7. Host Settings

Host settings remain host-global:

- connection details
- server version/compatibility
- default worktree directory
- agents available on that host
- platform/capabilities

They should not become a separate copy of all project settings.

Concrete changes:

- expose host connection, health, version, platform, and capabilities
- include compatibility warnings for mismatched client/server versions
- keep host-global defaults separate from per-project setup overrides

### 8. Runtime Ownership

Terminals, browser panes, agents, PTYs, filesystem operations, and setup scripts
must route through the workspace's host.

The UI can show project-first organization, but execution still happens on the
owning host.

Concrete changes:

- derive runtime target from workspace/setup host, not active sidebar grouping
- keep local, SSH, runtime, and future cloud execution behind the same routing
  contract
- audit filesystem, git, terminal, browser, agent, hook, and automation paths
  for repo-id assumptions

### 9. Compatibility And Availability

Workspace creation must handle:

- host offline
- project not set up
- host version too old
- client version too old
- unsupported platform
- missing agent on selected host

This should be surfaced before creation where possible.

Concrete changes:

- add capability/version probing to host records
- gate project setup and workspace creation on host readiness
- define behavior for new client/old server and old client/new server
- keep unsupported actions disabled with a specific reason

### 10. CLI / API

CLI and API commands need to accept the project-first model:

```bash
orca project setup --project <id> --host <id> --clone ...
orca workspace create --project <id> --host <id> --branch ...
orca project hosts list <project-id>
```

Existing commands should keep compatibility aliases where possible.

Concrete changes:

- add project/setup/workspace commands that take host explicitly
- keep old repo/worktree commands working as aliases where possible
- return structured availability errors instead of generic failures

### 11. Caches, Metadata, And Request Ownership

Caches and request ownership need to follow the same identity split.

Project-global caches can stay project keyed. Host-local caches must include the
host/setup key because two machines can have different refs, branches, worktree
paths, installed agents, filesystem state, and server capabilities for the same
project.

Concrete changes:

- decide which caches are project-global versus host/setup-local
- include host/setup ids in branch, worktree, status, filesystem, terminal, and
  remote capability cache keys
- keep request cancellation scoped to the host that owns the operation

### 12. Tests And Validation

The validation surface is broad because this changes identity, persistence,
runtime routing, and UI organization.

Concrete changes:

- migration tests for local, SSH, runtime, duplicate project-on-two-hosts, and
  missing/offline hosts
- selector tests for project/setup/workspace grouping
- workspace creation tests for ready, not set up, offline, incompatible, and
  unsupported hosts
- sidebar tests for single-host projects, mixed-host projects, host filters, and
  drag/reorder
- SSH end-to-end validation for remote setup and remote workspace creation
- Electron UI verification for the create-workspace and settings flows

## Implementation Scale

This is probably not a small patch.

Estimated change categories: 12 meaningful surfaces.

1. shared types and persistence
2. migration logic
3. main-process project/host setup APIs
4. renderer store normalization/selectors
5. sidebar grouping and drag/reorder behavior
6. create workspace flow
7. add/setup project flow
8. project settings
9. host settings
10. runtime routing/guards
11. CLI/API updates
12. tests and compatibility coverage

So the answer is: about 12 meaningful product/engineering surfaces need to
change, with the data model, migration, creation/setup flows, and runtime
routing being the most important and highest-risk pieces.

## Suggested Implementation Sequence

This should be implemented as an additive migration, not a big-bang rename.

1. Add project/setup types, selectors, and compatibility helpers while keeping
   existing `Repo` APIs alive.
2. Add persistence migration that derives one setup per existing repo.
3. Update store selectors so the sidebar and creation flows can read
   project-first data without requiring every backend call to change at once.
4. Update workspace creation to accept project plus host, then map through the
   selected setup to current worktree creation internals.
5. Add setup-on-host flows for local and SSH paths.
6. Split settings into project-global and host-specific sections with an
   explicit host selector.
7. Move sidebar default grouping to project-first while preserving host filters
   and host-first operational mode if we still want it.
8. Audit runtime routing and caches so every host-local operation is keyed by
   setup/host, not only project.
9. Add CLI/API compatibility commands.
10. Run migration, unit, SSH, and Electron validation before calling it done.

## Implementation Status

Landed so far:

- Added shared `Project` and `ProjectHostSetup` types.
- Added a pure compatibility projection from existing `Repo[]` into
  project-first `Project[]` and `ProjectHostSetup[]`.
- Added renderer store selectors that expose the projected model without
  duplicating derived state in Zustand.
- Added persisted `projects` and `projectHostSetups` compatibility fields that
  are backfilled from existing repos on load and kept in sync when repos are
  added, updated, reordered, or removed.
- Exposed read-only project/setup list APIs through local IPC, preload, and
  runtime RPC so newer clients can ask local or remote servers for the
  project-first compatibility model.
- Hydrated renderer store `projects` and `projectHostSetups` alongside repos,
  with a repo-derived fallback for older preloads/runtimes that do not yet
  implement the project APIs.
- Updated the sidebar `groupBy: repo` row builder to group by durable project
  identity when project/setup data exists, while keeping a repo-by-repo fallback
  for projects that have not been linked across hosts.
- Added a project-host-aware workspace creation target resolver. The visible
  composer still submits the current `repoId` for compatibility, but saved
  drafts can now carry `projectId`, `hostId`, and `projectHostSetupId`, and the
  initial creation target can resolve those fields through a ready setup before
  falling back to the legacy repo priority order.
- Added optional `projectId`, `hostId`, and `projectHostSetupId` ownership
  fields to `Worktree`/`WorktreeMeta`, threaded them through worktree merge
  paths, and stamped them for new local, SSH, folder, and runtime-created
  workspaces when project-host setup data is available.
- Added first-class setup-on-existing-folder plumbing through local IPC,
  preload, runtime RPC, runtime service, and the renderer repo slice. The new
  `projectHostSetup.setupExistingFolder` path returns `{ project, setup, repo }`
  and reuses the existing local/SSH/runtime repo import behavior underneath,
  with an identity guard so an imported folder does not silently become a
  different project.
- Added tests for local repos, SSH repos, same-provider multi-host grouping,
  no-identity same-name non-grouping, selector cache behavior, persistence
  backfill, repo mutation synchronization, renderer hydration, and runtime RPC
  routing. Sidebar row-builder tests now cover project-first multi-host grouping
  and same-name repo separation without project identity. Workspace target tests
  cover local-only fallback, focused-host setup selection, explicit
  project-plus-host resolution, same-name non-merging, and unavailable setup
  reasons.

Important limitation:

- This is not the full migration yet. `Repo` remains the source of truth for the
  compatibility records, and workspace creation still maps the resolved
  project-host setup back into the existing repo-centric `createWorktree` API.
  Existing workspaces without the new ownership metadata still infer host/project
  through their repo compatibility record. Settings and setup-on-host flows still
  use the current repo-centric APIs until later steps are implemented.

Remaining end-to-end work:

- teach workspace creation to resolve `{ projectId, hostId }` through a ready
  project-host setup
- add setup-on-host flows for local paths and SSH paths
- add clone/provision setup-on-host flows; existing-folder setup now has an API
  bridge, but not a complete user-facing project settings flow
- split settings into explicit client, host, project, and project-host setup
  scopes
- backfill explicit workspace project/setup/host ownership for existing
  metadata-only workspaces where safe, while keeping repo compatibility fallback
  for older servers and profiles
- audit runtime routing, cache keys, request cancellation, and stale-response
  handling for host/setup-local ownership
- add project-first CLI/API commands with compatibility aliases for existing
  repo/worktree commands
- validate migration, creation, settings, sidebar, SSH, and version-skew flows
  end to end

## Recommendation

Use the current host-first sidebar work as a useful transitional and optional
operational view.

For the long-term Orca model, move to project-first:

```text
Project -> ProjectHostSetup -> Workspace
```

This gives us:

- a less jarring experience for local-only users
- clean support for SSH machines and VMs
- clear handling for project exclusivity
- a natural future cloud VM monetization path
- a better fit for repo/worktree/task/agent workflows
