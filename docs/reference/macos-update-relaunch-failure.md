# macOS Update Relaunch Failure

## Summary

On May 18, 2026, a macOS update from `1.4.4-rc.0` to `1.4.6` appeared to
download successfully, closed Orca, did not relaunch, and left the installed
app on the old version after manual reopen.

The root cause was not the persistent PTY daemon by itself. The update was
still in ShipIt/Squirrel's silent install window when the old Orca app was
manually relaunched. ShipIt then detected one running instance of the target
app and aborted the replacement.

## Evidence

Relevant `ShipIt_stderr.log` entries:

```text
2026-05-18 13:05:57.222 ShipIt[...] Detected this as an install request
2026-05-18 13:05:57.554 ShipIt[...] Beginning installation
2026-05-18 13:08:24.290 ShipIt[...] Aborting update attempt because there are 1 running instances of the target app
2026-05-18 13:08:24.291 ShipIt[...] Installation cancelled: ... "App Still Running Error"
```

The old app process started during that install window:

```text
/Applications/Orca.app/Contents/MacOS/Orca
started: 2026-05-18 13:06:42
```

That places the manual relaunch after ShipIt began installing and before it
aborted.

## Why 40 Seconds Was Plausible

The app disappearing for roughly 40 seconds is not necessarily a failed update.
The macOS `1.4.6` arm64 update ZIP was about 609 MB, and ShipIt must validate,
unarchive, stage, move the old bundle aside, move the new bundle into place,
and then relaunch.

A prior successful update on the same machine took about 49 seconds:

```text
2026-05-17 14:14:42 ShipIt[...] Beginning installation
2026-05-17 14:15:21 ShipIt[...] Moving bundle from file:///Applications/Orca.app/
2026-05-17 14:15:30 ShipIt[...] Successfully launched application at file:///Applications/Orca.app/
```

The problem is that Orca provides no visible progress during that silent ShipIt
window, so a user can reasonably conclude the app failed to relaunch and start
the old app manually.

## Reference Behavior

Other desktop apps generally try to make this window explicit instead of letting
the app disappear without context.

- VS Code has the clearest update state model. Its updater state machine includes
  states such as `Downloading`, `Downloaded`, `Updating`, `Ready`,
  `Overwriting`, and `Restarting`, and those states surface in titlebar/menu UI
  with copy like `Installing Update...`, `Restart to Update`, and
  `Restarting to update, please wait...`.
  - Reference: `src/vs/platform/update/common/update.ts`
  - Reference: `src/vs/workbench/contrib/update/browser/updateTooltip.ts`
  - Reference: `src/vs/workbench/contrib/update/browser/update.ts`
  - Reference: `src/vs/platform/menubar/electron-main/menubar.ts`
- Superset Desktop explicitly documents that update install should bypass the
  normal quit protocol: `quitAndInstall()` plus immediate exit. Their note says
  coupling updater install to ordinary quit lifecycle was the wrong abstraction.
  The implementation also guards duplicate install clicks and clears cached
  updater state after errors so a bad cached download does not retry forever.
  - Reference: `apps/desktop/plans/20260405-quit-tray-lifecycle.md`
  - Reference: `apps/desktop/src/main/lib/auto-updater.ts`
  - Reference: `apps/desktop/src/main/lib/auto-updater.test.ts`
- Emdash sets an `installing` state before `quitAndInstall`, guards duplicate
  install requests, logs from/to versions, and rolls back install state if the
  app fails to quit within a timeout.
  - Reference: `src/main/core/updates/update-service.ts`
  - Reference: `src/renderer/lib/stores/update-store.ts`
- Tabby and WaveTerm use simpler Electron updater flows: set downloaded or
  installing state, then call `quitAndInstall`. They do not appear to address
  the silent macOS ShipIt gap as directly.
  - Reference: `tabby/app/lib/window.ts`
  - Reference: `waveterm/emain/updater.ts`

The practical lesson for Orca: update install is not a normal quit. It needs
lifecycle bypasses, persisted install-attempt state, and user-facing
progress/recovery semantics.

The OSS comparison did not show a common Electron/Squirrel pattern that removes
the macOS ShipIt window entirely. Most apps either make the wait visible, prevent
duplicate/reentrant install attempts, avoid normal quit barriers, or fall back to
manual update links. Real downtime reduction mostly comes from reducing the size
and filesystem cost of the app artifact.

Packaging references:

- WaveTerm packages only built `dist` output, explicitly excludes `node_modules`,
  and unpacks only executable Go binaries/schema files needed at runtime.
  - Reference: `electron-builder.config.cjs`
- Tabby keeps a broad package but excludes common unused source, docs, maps,
  tests, fonts, and development artifacts, and only unpacks native modules.
  - Reference: `electron-builder.yml`
- Superset Desktop materializes a named list of runtime native dependencies and
  uses that list to drive both `asarUnpack` and packaged node-module copies.
  - Reference: `apps/desktop/runtime-dependencies.ts`
  - Reference: `apps/desktop/electron-builder.ts`

## Daemon Context

Orca's PTY daemon is intentionally detached and can survive app updates. That
allows terminal sessions to warm-reattach after the new app launches.

This incident initially looked like a daemon-orphan issue because several daemon
helpers were running from old Orca bundles, including:

```text
/Applications/Orca.app/.../daemon-entry.js
/Applications/Orca 2.app/.../daemon-entry.js
```

But that was not sufficient to explain the failure:

- Daemon helpers use helper bundle identifiers such as `com.stablyai.orca.helper`.
- ShipIt's target-running check is based on the target app bundle identifier,
  `com.stablyai.orca`.
- A daemon from `/Applications/Orca.app` was alive during a successful May 17
  update, proving daemon survival is compatible with successful installation.

The stale `/Applications/Orca 2.app` daemon is still machine-specific clutter
worth cleaning up, but it was not the primary cause of this failed `1.4.6`
install.

## Failure Mode

1. Orca downloads the update.
2. User clicks install.
3. Orca closes its window and calls `autoUpdater.quitAndInstall`.
4. ShipIt begins installing in the background.
5. The install takes long enough that the user manually reopens Orca.
6. The old `/Applications/Orca.app` process starts while ShipIt is still trying
   to replace that same bundle.
7. ShipIt detects one running target app instance and aborts with
   `App Still Running Error`.
8. The next manual open launches the unchanged old version.

## Fix Direction

The fix should preserve daemon survival across updates, while preventing the old
app process from blocking ShipIt. Preventing the exact manual-relaunch repro is
necessary, but not sufficient; Orca must also know after restart whether the
requested install actually completed.

Four local guards remain appropriate:

- During updater-triggered quits, avoid blocking the main app process exit on
  the normal async daemon disconnect/checkpoint barrier. Normal quits still use
  that barrier.
- If the old app is relaunched while its ShipIt state points at a newer staged
  update and the matching ShipIt process is still running, immediately quit the
  old app before it opens windows or takes the single-instance path.
- On macOS, do not show `downloaded` or accept an install click merely because
  electron-updater reached 100%. Wait for Squirrel/Mac's native
  `update-downloaded` signal so the update is actually staged for install.
- Collapse duplicate `quitAndInstall` requests into one in-flight install.

These guards protect the exact repro where the user manually reopens Orca during
the silent install window. They are the emergency layer, not the complete
durability story.

Current branch status:

- `src/main/mac-update-relaunch-guard.ts` implements the stale relaunch guard.
- `src/main/index.ts` skips the async daemon disconnect/checkpoint barrier for
  updater-triggered quits.
- `src/main/updater-mac-install.ts` and `src/main/updater-events.ts` defer the
  macOS `downloaded` state until Squirrel/Mac is ready.
- `src/main/updater.ts` guards duplicate `quitAndInstall` requests.

The required next layer is durable recovery: Orca must persist install-attempt
state before quitting, clear it only after observing a successful relaunch onto
the target version, and use it to show a retryable recovery state if ShipIt exits
without installing the staged update.

## Durable Install Marker

Persist an install-in-progress marker before calling `quitAndInstall`. The file
belongs under Electron's user data directory via Node/Electron path APIs, not
beside the app bundle, so it survives bundle replacement across platforms and
works for SSH/daemon users whose terminal sessions remain alive while the UI
process exits.

Required fields:

- `schemaVersion`
- `attemptId`
- `platform`
- `currentVersion`
- `targetVersion`
- `stagedUpdateIdentity`, or `null` when the platform cannot provide a safe
  identity contract
- `startedAt`
- `lastObservedAt`
- `installDeadlineAt`
- `staleAfter`
- `shipItPid` when known on macOS
- `installState`: `preparing`, `installing`, `restarting`, or `recovery`
- `failureReason` when entering recovery

Marker ownership and persistence:

- The main process owns all marker reads, writes, validation, and clearing. The
  renderer receives `UpdateStatus`; it must not infer recovery from files.
- Persist the marker with fail-stop semantics before `quitAndInstall`: write a
  temp file in the same directory, flush file contents, rename or use a
  platform-appropriate atomic replace, and flush the containing directory where
  the platform supports it.
- If the pre-quit `preparing` or `installing` marker cannot be persisted, do not
  call `quitAndInstall`. Stay open, report `recovery`, and surface retry/manual
  recovery instead of quitting into an untracked native install attempt.
- Validate `schemaVersion`, required fields, version strings, timestamps, and
  platform before using a marker. Corrupt, partial, or future-schema reads enter
  recovery with a fresh check/download path; they are not silently cleared.

Staged update identity:

- On macOS, identity is derived from Squirrel/ShipIt's native state: the target
  bundle URL, update bundle URL, target bundle version, and any manifest,
  signature, or checksum available from the updater metadata.
- Retry may reuse a staged update only when the marker identity matches the
  current native updater cache identity. A missing or mismatched identity starts
  a fresh update check/download.
- Platforms without a safe staged identity persist `stagedUpdateIdentity: null`.
  Recovery on those platforms never assumes a cached native installer is still
  usable.

Write/update points:

- Write `preparing` after the user confirms install and before any quit path can
  close the last window.
- Move to `installing` immediately before `autoUpdater.quitAndInstall`.
- Move to `restarting` when the app has committed to updater-triggered quit and
  ordinary quit barriers have been bypassed.
- On macOS only, update `shipItPid`/`lastObservedAt` while the matching ShipIt
  process is observed. The ShipIt-specific probe must be platform-gated.

Clearing rules:

- Clear the marker only when the relaunched app's version is `targetVersion` or
  newer and the app has completed enough startup to report update status.
- Do not clear merely because the old app starts again, because that is the
  failure case.
- If the marker version is older than the running app version, clear it as a
  successful stale marker.

Timeout/stale handling:

- Set `installDeadlineAt` to a conservative install timeout, initially 10
  minutes from `startedAt`; this is intentionally longer than the observed
  40-150 second macOS window.
- Set `staleAfter` to a longer cleanup horizon, initially 24 hours, so Orca can
  distinguish a failed install from old metadata discovered much later.
- Treat the marker as active while the matching macOS ShipIt process is still
  running with high confidence.
- If `installDeadlineAt` expires and no matching ShipIt process is running,
  enter `recovery` instead of silently returning to `downloaded`.
- If the marker is very old or references a missing/stale staged update, clear
  it only after surfacing recovery with a manual download link or fresh update
  check. Log the stale marker fields before clearing after `staleAfter`.

ShipIt matching on macOS is high confidence only when all available signals
agree:

- The observed process command or executable path is under the current app
  bundle's `Squirrel.framework`.
- ShipIt state has `targetBundleURL` matching the current app bundle.
- ShipIt state has `updateBundleURL` and bundle version matching the marker's
  `targetVersion` and `stagedUpdateIdentity`.
- `lastObservedAt` is fresh and still inside the active install window.

Any ambiguous, stale, or partial match is low confidence. Low confidence enters
recovery instead of self-quitting the old app.

Safety invariant: while installer-active confidence is high, do not let the old
target app open windows or become the foreground single-instance app. If ShipIt
runs past `installDeadlineAt` plus a short grace period, keep the early self-quit
protection but log the overrun and use a best-effort native notification to point
the user at manual recovery. In-app recovery is allowed only after ShipIt is no
longer running, the match becomes low confidence, or the marker ages past
`staleAfter`.

Retry creates a new attempt. When the user chooses retry from recovery, Orca
atomically replaces the marker with a new `attemptId`, `startedAt`,
`lastObservedAt`, `installDeadlineAt`, `staleAfter`, `installState`, and staged
identity decision. Prior failure fields are retained only in logs or bounded
diagnostic history, not in the active marker that drives startup recovery and
duplicate-collapse behavior.

## Updater States

Orca should expose first-class updater states to the renderer and menu/tray
surface. The minimum states needed for this incident are:

- `downloaded`: update is staged and safe to offer `Restart and install`.
  On macOS, this must map to Squirrel/Mac's native `update-downloaded`, not only
  electron-updater's download progress reaching 100%.
- `preparing`: user confirmed install; marker is being written and UI should
  disable duplicate install actions.
- `installing`: `quitAndInstall` is in flight; duplicate requests collapse into
  the existing attempt.
- `restarting`: Orca is intentionally exiting for update. Normal quit cleanup
  that can block the main UI process is bypassed, while the PTY daemon remains
  detached for warm reattach.
- `recovery`: Orca restarted on the old version or detected a stale marker after
  ShipIt stopped. UI should present retry and manual recovery, not pretend the
  install succeeded.

Main-process ownership should be explicit:

| Owner / entrypoint | Responsibility | Resulting status |
| --- | --- | --- |
| Main updater service, install confirmation handler | Validate staged update identity, persist `preparing`, disable duplicate install actions | `preparing` |
| Main updater service, `quitAndInstall` path | Persist `installing`, then call `autoUpdater.quitAndInstall` only after the marker is durable | `installing` |
| Main app quit handler | Bypass ordinary quit barriers only for updater-triggered quit; keep daemon sessions detached | `restarting` |
| Main startup recovery check | Validate marker, compare running version and staged identity, choose ShipIt self-quit or recovery | `recovery` or cleared |
| Renderer/menu/tray subscribers | Display the main-process `UpdateStatus`; do not own marker state | mirrored status |

This keeps VS Code's lesson, the explicit state model, without requiring Orca to
copy VS Code's full updater architecture. It also matches the narrower Emdash
and Superset lessons: mark install-in-flight, prevent duplicate install calls,
roll back or recover when the quit/install path does not complete, and keep
updater install separate from ordinary app quit.

## Recovery Behavior

When Orca starts and finds an active marker:

1. If the running app version is `targetVersion` or newer, clear the marker and
   optionally show `Updated to <version>`.
2. On macOS, if a high-confidence matching ShipIt process is still running for
   the staged newer update, quit immediately before creating windows or taking
   the single-instance path.
   Optionally emit a best-effort native notification when permissions allow:
   `Orca is still installing the update. It will reopen automatically.`
3. On macOS, if the ShipIt match is absent, stale, ambiguous, or no longer
   running while the app is still below `targetVersion`, enter `recovery` and
   show `Update did not complete. Retry install.`
4. On non-macOS platforms, if the running version is below `targetVersion` and no
   platform installer-active signal exists, or `stagedUpdateIdentity` is absent
   or mismatched, enter `recovery` with fresh check/download/manual recovery.
   Non-macOS platforms must not self-quit based on macOS ShipIt assumptions.
5. Retry starts a new marker attempt. It may reuse the staged update only if the
   native updater cache identity still matches the failed marker; otherwise it
   starts a fresh update check/download.
6. Manual recovery should prefer a platform-specific installer URL when known.
   Otherwise link to the release page with copy naming the user's platform.
   Terminal daemon/session state must stay intact.

## Recommended UX Direction

The local guards prevent a manual relaunch from poisoning ShipIt, but they do
not solve the user's mental model. A closed-app install window of tens of
seconds, or longer on slow disks, still looks like failure.

Recommended behavior:

1. Before install, make the action explicit:
   - Primary button: `Restart and install`
   - Supporting copy: `Orca may be closed for a minute or two while macOS applies the update. On slow disks this can take several minutes.`
2. On click, send explicit `preparing`, `installing`, and `restarting` statuses
   to the renderer before windows close.
3. Persist the install marker before calling `quitAndInstall`.
4. During updater-triggered quit, bypass ordinary quit barriers that can delay
   the main app process from exiting. Preserve daemon survival.
5. If the old app is relaunched while ShipIt is installing the newer staged
   bundle, immediately quit the old app. Optionally emit a best-effort native
   notification when permissions allow:
   `Orca is still installing the update. It will reopen automatically.`
6. On successful relaunch, clear the marker and show a lightweight confirmation,
   e.g. `Updated to 1.4.6`.
7. If the marker is still present after a timeout and no matching ShipIt process
   is running, show a recoverable error card:
   `Update did not complete. Retry install.`

This combines the competitor durability patterns with an Orca-specific recovery
marker for the May 18 failure mode: VS Code makes updater progress/restart
states first-class, Emdash rolls back an installing state when quit does not
complete, and Superset separates updater install from ordinary quit while
guarding duplicate native install calls.

## Acceptance Criteria

The fix is complete only when all of these are true:

- The May 18 repro is prevented: manually reopening old Orca during macOS ShipIt
  install cannot make ShipIt abort because the target app is running.
- An install attempt is persisted before `quitAndInstall`, includes the required
  fields above, and survives app quit/restart. If durable marker persistence
  fails, Orca does not call `quitAndInstall`.
- The marker clears after a successful relaunch onto the target version or newer.
- If ShipIt exits without installing and Orca restarts on the old version, Orca
  enters `recovery` with retry and manual recovery instead of silently returning
  to the old `downloaded` state.
- Duplicate install clicks produce one native `quitAndInstall` attempt for a
  given marker/attempt.
- Recovery retry creates a new marker attempt with reset attempt-scoped fields;
  stale failure metadata is kept only in logs or bounded diagnostics.
- macOS-only behavior, including ShipIt process detection and stale-relaunch
  self-termination, is gated to macOS. Non-macOS updater behavior keeps using
  platform-appropriate Electron updater semantics.
- Non-macOS recovery enters fresh check/download/manual recovery when the app is
  still below `targetVersion` and no trusted installer-active signal or matching
  staged identity exists.
- Updater-triggered quit does not kill or require local-only PTY daemon cleanup;
  SSH-backed and detached daemon sessions survive for warm reattach.
- Tests cover stale relaunch prevention, marker write/clear/recovery, duplicate
  install collapse, timeout/stale marker handling, and the non-macOS no-op path
  for ShipIt-specific guards.
- Logs include attempt id, from/to versions, state transitions, ShipIt detection
  when available, platform, and recovery reason. Cache URLs, file URLs, and
  local paths are redacted or hashed.

## Follow-Up Work

The underlying user experience is still poor until the durable UX direction
above is implemented. Even with the relaunch guard, the app can disappear for
tens of seconds or longer with no visible progress.

Longer-term improvements:

- Reduce macOS artifact size or install staging time. Start by auditing broad
  `asarUnpack` entries and `extraResources`, especially `resources/**`,
  `out/main/chunks/**`, speech/ML/native packages, helper apps, onboarding media,
  relay assets, and duplicated runtime dependencies.
- Consider an external progress surface only if native notifications and the
  persisted recovery state still leave too much invisible downtime.
