# Move AI Capabilities To The Top In Settings

## Problem

The Settings sidebar group order puts AI Capabilities after Interface in `src/renderer/src/components/settings/Settings.tsx:69`, so Orchestration, Computer Use, and Voice are lower in the navigation than requested.

The rendered pane order also places the AI capability panes after several workflow and interface panes. Empty-search Settings renders only the active pane, but non-empty Settings search renders every matching `SettingsSection` in JSX order. Sidebar order, metadata order, and JSX order should therefore describe the same hierarchy for capability panes.

`buildSettingsNavigationMetadata` currently emits Orchestration after Browser/Notifications, while Computer Use and Voice are emitted after Remote entries. This metadata feeds the Settings sidebar, Settings search filtering, and Cmd+J Settings results, so it also needs to reflect the new ordering.

Important constraint: the sidebar renders whole groups from `SETTINGS_NAV_GROUPS`, then filters sections by each section's `group`. Moving `capabilities` to immediately after `setup` puts AI Capabilities after the full Set Up group, not immediately after the General row. Putting AI Capabilities between General and Agents would require splitting or reclassifying Set Up sections, which is outside this change.

## Goal

Move the AI Capabilities sidebar group near the top of Settings: immediately after Set Up and before Workflows. Preserve existing pane content, search behavior, deep links, platform gating, web-client gating, and remote/SSH behavior.

## Non-goals

- Do not rename panes, groups, labels, descriptions, or badges.
- Do not change any AI capability settings behavior.
- Do not change remote runtime, SSH, browser, notification, or provider account behavior.
- Do not redesign Settings layout or introduce new visual tokens.
- Do not split the Set Up group or move Agents, AI Provider Accounts, or Integrations into another group.

## Design

1. Reorder `SETTINGS_NAV_GROUPS` so `capabilities` appears immediately after `setup`. This moves the AI Capabilities group above Workflows and Interface in the Settings sidebar while leaving group IDs and titles unchanged.

2. Reorder `buildSettingsNavigationMetadata` so capability sections are contiguous and emitted immediately after the existing Set Up entries:
   - Always-visible: `orchestration`.
   - Desktop-only: `computer-use`, `voice`.
   Keep `agents`, `accounts`, and `integrations` in `setup` before the capability block. The sidebar cannot interleave another group inside Set Up, and reclassifying those rows would be a broader IA change.

3. Reorder the JSX `SettingsSection` blocks in `Settings.tsx` to match the visible hierarchy after Set Up:
   - `general`
   - `agents`, `accounts`, `integrations`
   - `orchestration`
   - desktop-only `computer-use`, `voice`
   - the remaining setup/workflow/interface/remote/safety/experimental/repo sections in their existing relative order

4. Add focused tests in `useSettingsNavigationMetadata.test.ts` for desktop and web order. The desktop assertion should verify the prefix `general -> agents -> accounts -> integrations -> orchestration -> computer-use -> voice -> git`. The web assertion should verify `general -> agents -> accounts -> integrations -> orchestration -> git` and continue to exclude desktop-only panes.

## Edge Cases

- Web client must still hide `computer-use` and `voice`, while keeping `orchestration` near the top.
- Non-macOS desktop should still show the Computer Use preview tooltip and should not show macOS Permissions.
- Search and deep links must keep working by keeping section IDs, `SettingsNavTarget` values, `SettingsSection` IDs, and `searchEntries={getSectionSearchEntries(id)}` aligned. IDs alone are not sufficient if metadata and JSX drift.
- Existing lazy mounting should keep loading only General initially. `settings-load-performance.ts` eagerly mounts only `general`; moving JSX must not add capability IDs to `EAGER_SECTION_IDS`.
- Remote/SSH use must remain unaffected because no path, runtime, provider, or IPC behavior changes.
- Repo hook inspection, runtime identity invalidation, and font loading should remain untouched. This change is static ordering only; do not add caching, persistence, IPC calls, or cross-window synchronization.
- `openComputerUseFromBrowser` should still land on `computer-use` on desktop. On web, Browser and Computer Use remain hidden, so this path stays unavailable.

## Rollout

1. Update navigation group order in `Settings.tsx`.
2. Move capability metadata blocks in `useSettingsNavigationMetadata.ts`, preserving the existing desktop-only spread for `computer-use` and `voice`.
3. Move corresponding `SettingsSection` JSX blocks in `Settings.tsx`.
4. Add order assertions in `useSettingsNavigationMetadata.test.ts`.
5. Run the focused metadata test. Then run broader typecheck/lint if this is being taken through submission.
