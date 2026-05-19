/* eslint-disable max-lines */
import { app, BrowserWindow, powerMonitor } from 'electron'
import type { NsisUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import type { UpdateStatus } from '../shared/types'
import { killAllPty } from './ipc/pty'
import { loadElectronAutoUpdater, type ElectronAutoUpdater } from './electron-updater-loader'
import {
  beginMacUpdateDownload,
  deferMacQuitUntilInstallerReady,
  markMacQuitAndInstallInFlight
} from './updater-mac-install'
import { registerAutoUpdaterHandlers } from './updater-events'
import {
  compareVersions,
  isBenignCheckFailure,
  isMissingUpdateManifestFailure,
  isPrereleaseVersion,
  statusesEqual
} from './updater-fallback'
import { fetchNewerReleaseTags, getReleaseDownloadUrl } from './updater-prerelease-feed'
import { fetchNudge, shouldApplyNudge } from './updater-nudge'
import {
  clearUpdateInstallMarker,
  createUpdateInstallMarker,
  evaluateUpdateInstallMarker,
  getUpdateInstallMarkerPath,
  readUpdateInstallMarkerResult,
  updateInstallMarkerObservation,
  updateInstallMarkerState,
  writeUpdateInstallMarker,
  type UpdateInstallMarker,
  type UpdateStagedIdentity
} from './update-install-marker'
import {
  getCurrentMacShipItInstallIdentity,
  getMacAppBundlePath,
  listShipItProcesses,
  observeMacShipItInstall
} from './mac-update-relaunch-guard'

type CheckFailureSource = 'event' | 'promise' | 'fallback-promise'
type MissingManifestPrereleaseFallbackResult = { userInitiated: boolean }
type PrimaryEventSuppression = { failureKey: string; error: unknown }

const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const AUTO_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000
const NUDGE_POLL_INTERVAL_MS = 30 * 60 * 1000
const NUDGE_ACTIVATION_COOLDOWN_MS = 5 * 60 * 1000
const QUIT_AND_INSTALL_DELAY_MS = 100

let mainWindowRef: BrowserWindow | null = null
let currentStatus: UpdateStatus = { state: 'idle' }
let userInitiatedCheck = false
let onBeforeQuitCleanup: (() => void) | null = null
let autoUpdaterInitialized = false
// Why: Shift-clicking "Check for Updates" opts the user into the RC release
// channel for the rest of this process. The generic feed still gets pinned to
// a concrete tag on every check so cancelled RCs without manifests are skipped.
let includePrereleaseActive = false
let availableVersion: string | null = null
let availableReleaseUrl: string | null = null
let availableUpdateChecksum: string | null = null
let pendingCheckFailureKey: string | null = null
let pendingCheckFailurePromise: Promise<void> | null = null
let autoUpdateCheckTimer: ReturnType<typeof setTimeout> | null = null
let nudgeCheckTimer: ReturnType<typeof setTimeout> | null = null
let pendingQuitAndInstallTimer: ReturnType<typeof setTimeout> | null = null
let pendingInstallMarker: UpdateInstallMarker | null = null
let persistLastUpdateCheckAt: ((timestamp: number) => void) | null = null
let _getLastUpdateCheckAt: (() => number | null) | null = null
let backgroundCheckLaunchPending = false
let activeUpdateNudgeId: string | null = null
let awaitingNudgeCheckOutcome = false
let nudgeCheckInFlight = false
let lastNudgeCheckAt = 0
let pendingPrereleaseFallback: {
  primaryTag: string
  fallbackTag: string
  // Why: the primary promise cleanup can run after fallback starts; fallback
  // events need the attempt-scoped initiation state, not the mutable global.
  userInitiated: boolean
  suppressedPrimaryPromiseFailureKey: string | null
  suppressedPrimaryEventFailure: PrimaryEventSuppression | null
  suppressedFallbackPromiseFailureKey: string | null
  suppressedFallbackEventFailureKey: string | null
  fallbackResultHandled: boolean
  fallbackCheckingForUpdateSeen: boolean
  retryLaunched: boolean
} | null = null

let _getPendingUpdateNudgeId: (() => string | null) | null = null
let _getDismissedUpdateNudgeId: (() => string | null) | null = null
let _setPendingUpdateNudgeId: ((id: string | null) => void) | null = null
let _setDismissedUpdateNudgeId: ((id: string | null) => void) | null = null
// Why: guards against duplicate download() calls when both the card and
// Settings trigger a download before the first download-progress event
// flips the status to 'downloading'.
let downloadInFlight = false
/** Guards against the macOS `activate` handler re-opening the old version
 *  while Squirrel's ShipIt is replacing the .app bundle. */
let quittingForUpdate = false
let autoUpdater: ElectronAutoUpdater | null = null

function getAutoUpdater(): ElectronAutoUpdater {
  if (!autoUpdater) {
    autoUpdater = loadElectronAutoUpdater()
  }
  return autoUpdater
}

function clearAvailableUpdateContext(): void {
  availableVersion = null
  availableReleaseUrl = null
  availableUpdateChecksum = null
}

function clearPrereleaseFallbackContext(): void {
  pendingPrereleaseFallback = null
}

function clearPendingUpdateNudge(): void {
  activeUpdateNudgeId = null
  awaitingNudgeCheckOutcome = false
  _setPendingUpdateNudgeId?.(null)
}

function getPersistedPendingUpdateNudgeId(): string | null {
  return _getPendingUpdateNudgeId?.() ?? null
}

function decorateStatusWithActiveNudge(status: UpdateStatus): UpdateStatus {
  // Why: only actionable/error states carry the nudge marker so the renderer
  // can tell whether a dismiss should also acknowledge the campaign. Cycle-
  // boundary states (idle, checking, not-available) never need it.
  if (!activeUpdateNudgeId) {
    return status
  }
  if (status.state === 'idle' || status.state === 'checking' || status.state === 'not-available') {
    return status
  }
  return { ...status, activeNudgeId: activeUpdateNudgeId }
}

function sendStatus(status: UpdateStatus): void {
  if (awaitingNudgeCheckOutcome) {
    if (status.state === 'available') {
      awaitingNudgeCheckOutcome = false
    } else if (
      status.state === 'idle' ||
      status.state === 'not-available' ||
      status.state === 'error'
    ) {
      // Why: when a nudge-triggered check finds no update (or errors out),
      // move the campaign to dismissed so it doesn't re-fire on the next
      // poll cycle. Without this, a nudge whose version range includes
      // already-up-to-date users would loop every 30 minutes, each time
      // triggering a redundant checkForUpdates() and clearing the persisted
      // dismissedUpdateVersion.
      if (activeUpdateNudgeId) {
        _setDismissedUpdateNudgeId?.(activeUpdateNudgeId)
      }
      clearPendingUpdateNudge()
    }
  }

  const decoratedStatus = decorateStatusWithActiveNudge(status)

  // Why: reset the in-flight guard when the status moves past the
  // window where duplicate download() calls are possible.
  if (
    decoratedStatus.state === 'downloading' ||
    decoratedStatus.state === 'error' ||
    decoratedStatus.state === 'idle' ||
    decoratedStatus.state === 'recovery'
  ) {
    downloadInFlight = false
  }
  if (statusesEqual(currentStatus, decoratedStatus)) {
    return
  }
  currentStatus = decoratedStatus
  mainWindowRef?.webContents.send('updater:status', decoratedStatus)
}

function clearBackgroundCheckLaunchPending(): void {
  backgroundCheckLaunchPending = false
}

function sendErrorStatus(message: string, userInitiated?: boolean): void {
  if (
    currentStatus.state === 'error' &&
    currentStatus.message === message &&
    currentStatus.userInitiated === userInitiated
  ) {
    return
  }
  sendStatus({ state: 'error', message, userInitiated })
}

function getKnownReleaseUrl(): string | undefined {
  return availableReleaseUrl ?? undefined
}

function hasNewerDownloadedVersion(): boolean {
  return availableVersion !== null && compareVersions(availableVersion, app.getVersion()) > 0
}

function getPendingInstallVersion(): string {
  if (availableVersion) {
    return availableVersion
  }
  if (currentStatus.state === 'downloading' || currentStatus.state === 'downloaded') {
    return currentStatus.version
  }
  if (currentStatus.state === 'recovery') {
    return currentStatus.targetVersion ?? ''
  }
  return ''
}

function getMarkerPath(): string | null {
  try {
    return getUpdateInstallMarkerPath(app.getPath('userData'))
  } catch (error) {
    console.warn('[updater] install marker path unavailable:', String(error))
    return null
  }
}

function getStagedUpdateIdentity(targetVersion: string): UpdateStagedIdentity | null {
  if (process.platform === 'darwin') {
    const nativeIdentity = getCurrentMacShipItInstallIdentity()
    return {
      kind: 'mac-squirrel',
      targetVersion,
      targetBundleURL: nativeIdentity?.targetBundleURL ?? null,
      updateBundleURL: nativeIdentity?.updateBundleURL ?? null,
      updateBundleVersion: nativeIdentity?.updateBundleVersion ?? null,
      updateChecksum: availableUpdateChecksum,
      releaseUrl: getKnownReleaseUrl() ?? null
    }
  }
  return null
}

function logInstallMarkerTransition(marker: UpdateInstallMarker, state: string): void {
  console.info(
    `[updater] install marker ${state}: attempt=${marker.attemptId} platform=${marker.platform} from=${marker.currentVersion} to=${marker.targetVersion}`
  )
}

function getReusablePendingInstallMarker(targetVersion: string): UpdateInstallMarker | null {
  if (
    pendingInstallMarker?.currentVersion === app.getVersion() &&
    pendingInstallMarker.targetVersion === targetVersion &&
    pendingInstallMarker.platform === process.platform
  ) {
    return pendingInstallMarker
  }
  return null
}

function persistUpdateInstallAttemptMarker(
  targetVersion: string,
  options: { reusePendingAttempt: boolean }
): UpdateInstallMarker | null {
  const marker = options.reusePendingAttempt ? getReusablePendingInstallMarker(targetVersion) : null
  const attemptMarker =
    marker ??
    createUpdateInstallMarker({
      currentVersion: app.getVersion(),
      targetVersion,
      platform: process.platform,
      stagedUpdateIdentity: getStagedUpdateIdentity(targetVersion)
    })

  const markerPath = getMarkerPath()
  if (!markerPath) {
    sendRecoveryStatus(attemptMarker, 'marker-path-unavailable')
    return null
  }

  try {
    // Why: recovery retries are new attempts, but the later quit must keep the
    // same attempt id so startup can distinguish this retry from the failed one.
    writeUpdateInstallMarker(markerPath, attemptMarker)
    pendingInstallMarker = attemptMarker
    logInstallMarkerTransition(attemptMarker, 'preparing')
    sendStatus({ state: 'preparing', version: targetVersion })
    return attemptMarker
  } catch (error) {
    console.error(
      `[updater] failed to persist install marker: attempt=${attemptMarker.attemptId} platform=${attemptMarker.platform} from=${attemptMarker.currentVersion} to=${attemptMarker.targetVersion} error=${String(error)}`
    )
    sendRecoveryStatus(attemptMarker, 'marker-preparing-write-failed')
    return null
  }
}

function sendRecoveryStatus(marker: UpdateInstallMarker, reason: string): void {
  availableVersion = marker.targetVersion
  pendingInstallMarker = null
  sendStatus({
    state: 'recovery',
    currentVersion: app.getVersion(),
    targetVersion: marker.targetVersion,
    message: 'Update did not complete. Retry install.',
    releaseUrl: getKnownReleaseUrl() ?? undefined
  })
  console.warn(
    `[updater] install recovery: attempt=${marker.attemptId} platform=${marker.platform} from=${marker.currentVersion} to=${marker.targetVersion} reason=${reason}`
  )
}

function getReleaseTagForVersion(version: string): string {
  return `v${version}`
}

function pinReleaseFeedToVersion(version: string): void {
  const url = getReleaseDownloadUrl(getReleaseTagForVersion(version))
  console.info(`[updater] release feed pinned to recovery target: version=${version} → ${url}`)
  getAutoUpdater().setFeedURL({ provider: 'generic', url })
}

function sendInvalidMarkerRecoveryStatus(reason: string): void {
  pendingInstallMarker = null
  sendStatus({
    state: 'recovery',
    currentVersion: app.getVersion(),
    targetVersion: null,
    message: 'Update metadata was unreadable. Check for updates again.'
  })
  console.warn(`[updater] install recovery: reason=invalid-marker detail=${reason}`)
}

function observeActiveInstaller(marker: UpdateInstallMarker): {
  active: boolean
  shipItPid?: number
  reason: string
} {
  if (process.platform !== 'darwin') {
    return { active: false, reason: 'non-macos' }
  }
  const appBundlePath = getMacAppBundlePath(process.execPath)
  const nativeIdentity = getCurrentMacShipItInstallIdentity()
  if (!appBundlePath || !nativeIdentity) {
    return { active: false, reason: 'missing-native-identity' }
  }
  const observation = observeMacShipItInstall({
    appBundlePath,
    appVersion: app.getVersion(),
    platform: process.platform,
    shipItProcesses: listShipItProcesses(),
    shipItState: {
      targetBundleURL: nativeIdentity.targetBundleURL,
      updateBundleURL: nativeIdentity.updateBundleURL
    },
    updateBundleVersion: nativeIdentity.updateBundleVersion,
    marker
  })
  return {
    active: observation.confidence === 'high',
    shipItPid: observation.shipItPid,
    reason: observation.reason
  }
}

function initializeInstallRecoveryState(): void {
  const markerPath = getMarkerPath()
  if (!markerPath) {
    return
  }

  const markerRead = readUpdateInstallMarkerResult(markerPath)
  if (markerRead.status === 'invalid') {
    sendInvalidMarkerRecoveryStatus(markerRead.reason)
    clearUpdateInstallMarker(markerPath)
    return
  }
  const marker = markerRead.status === 'valid' ? markerRead.marker : null
  const installer = marker ? observeActiveInstaller(marker) : { active: false, reason: 'no-marker' }
  const decision = evaluateUpdateInstallMarker({
    marker,
    runningVersion: app.getVersion(),
    platform: process.platform,
    installerActive: installer.active
  })
  if (decision.action === 'none') {
    return
  }
  if (decision.action === 'installer-active') {
    try {
      const next = updateInstallMarkerObservation(markerPath, decision.marker, {
        shipItPid: installer.shipItPid
      })
      console.info(
        `[updater] install still active: attempt=${next.attemptId} platform=${next.platform} from=${next.currentVersion} to=${next.targetVersion} shipItPid=${next.shipItPid ?? 'unknown'} reason=${installer.reason}`
      )
    } catch (error) {
      console.warn(
        `[updater] failed to update active install marker before self-quit: attempt=${decision.marker.attemptId} error=${String(error)}`
      )
    }
    // Why: if this process reached normal updater startup while ShipIt is
    // still active, keeping the old target app open can abort the native
    // replacement. Quit even after the early stale-relaunch guard as a backup.
    quittingForUpdate = true
    app.quit()
    return
  }
  if (decision.action === 'clear') {
    clearUpdateInstallMarker(markerPath)
    console.info(`[updater] cleared install marker after ${decision.reason}`)
    return
  }

  sendRecoveryStatus(decision.marker, decision.reason)
  if (decision.shouldClearMarker) {
    clearUpdateInstallMarker(markerPath)
  }
}

function getCheckFailureKey(message: string, userInitiated?: boolean): string {
  return `${userInitiated ? 'user' : 'auto'}:${message}`
}

function clearPrereleaseFallbackContextIfSettled(): void {
  if (
    pendingPrereleaseFallback?.fallbackResultHandled &&
    !pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey &&
    !pendingPrereleaseFallback.suppressedPrimaryEventFailure &&
    !pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey &&
    !pendingPrereleaseFallback.suppressedFallbackEventFailureKey
  ) {
    clearPrereleaseFallbackContext()
  }
}

function getInstallMarkerForQuit(marker = pendingInstallMarker): UpdateInstallMarker | null {
  if (marker) {
    return marker
  }
  const targetVersion = getPendingInstallVersion()
  if (!targetVersion || compareVersions(targetVersion, app.getVersion()) <= 0) {
    sendErrorStatus('No staged update is ready to install.')
    return null
  }
  // Why: macOS can resume a deferred app quit directly from Squirrel's native
  // ready signal, bypassing the renderer IPC path that normally prepares this.
  return persistUpdateInstallAttemptMarker(targetVersion, { reusePendingAttempt: true })
}

function performQuitAndInstall(marker = pendingInstallMarker): boolean {
  if (pendingQuitAndInstallTimer) {
    clearTimeout(pendingQuitAndInstallTimer)
    pendingQuitAndInstallTimer = null
  }

  const installMarker = getInstallMarkerForQuit(marker)
  if (!installMarker) {
    return false
  }

  const markerPath = getMarkerPath()
  if (markerPath) {
    try {
      pendingInstallMarker = updateInstallMarkerState(markerPath, installMarker, 'installing')
      logInstallMarkerTransition(pendingInstallMarker, 'installing')
      sendStatus({ state: 'installing', version: pendingInstallMarker.targetVersion })
    } catch (error) {
      sendRecoveryStatus(installMarker, `marker-installing-write-failed:${String(error)}`)
      return false
    }
  }

  if (pendingInstallMarker && markerPath) {
    try {
      pendingInstallMarker = updateInstallMarkerState(
        markerPath,
        pendingInstallMarker,
        'restarting'
      )
      logInstallMarkerTransition(pendingInstallMarker, 'restarting')
      sendStatus({ state: 'restarting', version: pendingInstallMarker.targetVersion })
    } catch (error) {
      sendRecoveryStatus(pendingInstallMarker, `marker-restarting-write-failed:${String(error)}`)
      return false
    }
  }

  // Set this before window teardown so the `activate` handler in index.ts
  // won't re-open the old version while Squirrel's ShipIt is replacing
  // the .app bundle. Without this guard the quit can resurrect the old
  // process and leave ShipIt unable to replace it.
  quittingForUpdate = true

  killAllPty()
  onBeforeQuitCleanup?.()

  for (const win of BrowserWindow.getAllWindows()) {
    win.removeAllListeners('close')
  }

  markMacQuitAndInstallInFlight()
  getAutoUpdater().quitAndInstall(false, true)
  return true
}

async function sendCheckFailureStatus(
  message: string,
  userInitiated?: boolean,
  source: CheckFailureSource = 'promise',
  sourceError?: unknown
): Promise<void> {
  const failureKey = getCheckFailureKey(message, userInitiated)
  if (
    source === 'promise' &&
    pendingPrereleaseFallback?.suppressedPrimaryPromiseFailureKey === failureKey
  ) {
    pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey = null
    clearPrereleaseFallbackContextIfSettled()
    return
  }
  if (
    source === 'fallback-promise' &&
    pendingPrereleaseFallback?.suppressedFallbackPromiseFailureKey === failureKey
  ) {
    pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey = null
    clearPrereleaseFallbackContextIfSettled()
    return
  }

  if (
    retryPrereleaseFallbackAfterMissingManifest(
      message,
      userInitiated,
      source,
      failureKey,
      sourceError
    )
  ) {
    return
  }

  if (pendingCheckFailureKey === failureKey && pendingCheckFailurePromise) {
    return pendingCheckFailurePromise
  }

  const handleFailure = async (): Promise<void> => {
    if (isBenignCheckFailure(message)) {
      // Why: release transition failures (missing latest.yml while a new
      // release is being published) and network blips are transient. Schedule
      // a background retry so the notification arrives once the release
      // finishes, and intentionally skip persistLastUpdateCheckAt — the check
      // didn't truly complete, and recording a timestamp would suppress the
      // next startup check.
      console.warn('[updater] benign check failure:', message)
      clearAvailableUpdateContext()
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      if (userInitiated) {
        // Why: a user-initiated click expects visible feedback — silently
        // dropping to 'idle' makes the button look broken. The card already
        // prefixes "Could not check for updates." and Settings prefixes
        // "Update check failed.", so the message here only carries the
        // actionable cause.
        sendErrorStatus("Couldn't reach the update server. Try again in a few minutes.", true)
      } else {
        sendStatus({ state: 'idle' })
      }
      return
    }

    clearAvailableUpdateContext()
    persistLastUpdateCheckAt?.(Date.now())
    if (!userInitiated) {
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
    }
    sendErrorStatus(message, userInitiated)
  }

  pendingCheckFailureKey = failureKey
  pendingCheckFailurePromise = handleFailure().finally(() => {
    if (pendingCheckFailureKey === failureKey) {
      pendingCheckFailureKey = null
      pendingCheckFailurePromise = null
    }
  })
  return pendingCheckFailurePromise
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

function scheduleAutomaticUpdateCheck(delayMs: number): void {
  if (autoUpdateCheckTimer) {
    clearTimeout(autoUpdateCheckTimer)
  }
  autoUpdateCheckTimer = setTimeout(() => {
    // Why: Orca is often left running for days. A one-shot startup check means
    // users can miss fresh releases entirely, so we always keep the next
    // background attempt scheduled in the main process instead of tying checks
    // to relaunches or renderer lifetime.
    runBackgroundUpdateCheck()
  }, delayMs)
}

function recordCompletedUpdateCheck(): void {
  persistLastUpdateCheckAt?.(Date.now())
}

function getMissingManifestPrereleaseFallbackUserInitiated(): boolean | null {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return null
  }
  return pendingPrereleaseFallback.userInitiated
}

function markMissingManifestPrereleaseFallbackChecking(): void {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return
  }
  pendingPrereleaseFallback.fallbackCheckingForUpdateSeen = true
}

function consumeMissingManifestPrereleaseFallbackResult(): MissingManifestPrereleaseFallbackResult | null {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return null
  }
  const result = { userInitiated: pendingPrereleaseFallback.userInitiated }
  pendingPrereleaseFallback.fallbackResultHandled = true
  clearPrereleaseFallbackContextIfSettled()
  return result
}

function suppressMissingManifestPrereleaseFallbackPromiseFailure(message: string): void {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return
  }
  pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey = getCheckFailureKey(
    message,
    pendingPrereleaseFallback.userInitiated
  )
}

function shouldSuppressMissingManifestPrereleaseFallbackEvent(
  message: string,
  error: unknown
): boolean {
  if (!pendingPrereleaseFallback?.retryLaunched) {
    return false
  }
  const failureKey = getCheckFailureKey(message, pendingPrereleaseFallback.userInitiated)
  const primaryEventSuppression = pendingPrereleaseFallback.suppressedPrimaryEventFailure
  if (primaryEventSuppression?.failureKey === failureKey) {
    const isPrimaryPromisePair = primaryEventSuppression.error === error
    // Why: after fallback checking starts, same-message errors may belong to
    // the fallback attempt, so message matching alone is not safe.
    if (isPrimaryPromisePair || !pendingPrereleaseFallback.fallbackCheckingForUpdateSeen) {
      pendingPrereleaseFallback.suppressedPrimaryEventFailure = null
      clearPrereleaseFallbackContextIfSettled()
      return true
    }
  }
  if (pendingPrereleaseFallback.suppressedFallbackEventFailureKey === failureKey) {
    pendingPrereleaseFallback.suppressedFallbackEventFailureKey = null
    clearPrereleaseFallbackContextIfSettled()
    return true
  }
  return false
}

function markMissingManifestPrereleaseFallbackPromiseHandled(message: string): void {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return
  }
  pendingPrereleaseFallback.suppressedFallbackEventFailureKey = getCheckFailureKey(
    message,
    pendingPrereleaseFallback.userInitiated
  )
}

async function pinDefaultReleaseFeed(): Promise<void> {
  const autoUpdater = getAutoUpdater()
  // Why: the /releases/latest/download/ redirect can move between the update
  // check and the later manual download click. Pinning to the concrete tag
  // keeps the manifest and ZIP asset on the same release.
  //
  // Prerelease users still need any-channel resolution so they can move to a
  // newer RC or the next stable. Stable users should only resolve stable tags.
  const currentVersion = app.getVersion()
  const includePrerelease = includePrereleaseActive || isPrereleaseVersion(currentVersion)
  const releaseTags = await fetchNewerReleaseTags(currentVersion, includePrerelease ? 2 : 1, {
    includePrerelease
  })
  const newerTag = releaseTags[0] ?? null
  const fallbackTag = includePrerelease ? (releaseTags[1] ?? null) : null
  pendingPrereleaseFallback =
    includePrerelease && newerTag && fallbackTag
      ? {
          primaryTag: newerTag,
          fallbackTag,
          userInitiated: false,
          suppressedPrimaryPromiseFailureKey: null,
          suppressedPrimaryEventFailure: null,
          suppressedFallbackPromiseFailureKey: null,
          suppressedFallbackEventFailureKey: null,
          fallbackResultHandled: false,
          fallbackCheckingForUpdateSeen: false,
          retryLaunched: false
        }
      : null
  // Why: console.info goes to stdout and is captured by Console.app on macOS
  // and by --enable-logging elsewhere. This is the only window we have into
  // the updater on a user's machine when something goes wrong. Cheap to keep,
  // invaluable when triaging.
  if (newerTag) {
    const url = getReleaseDownloadUrl(newerTag)
    console.info(
      `[updater] release feed pinned: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
    )
    autoUpdater.setFeedURL({ provider: 'generic', url })
  } else {
    clearPrereleaseFallbackContext()
    const url = 'https://github.com/stablyai/orca/releases/latest/download'
    console.info(
      `[updater] release feed fallback: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
    )
    autoUpdater.setFeedURL({ provider: 'generic', url })
  }
}

function retryPrereleaseFallbackAfterMissingManifest(
  message: string,
  userInitiated: boolean | undefined,
  source: CheckFailureSource,
  failureKey: string,
  sourceError?: unknown
): boolean {
  if (
    !pendingPrereleaseFallback ||
    pendingPrereleaseFallback.retryLaunched ||
    !isMissingUpdateManifestFailure(message)
  ) {
    return false
  }

  // Why: a published tag can briefly point at a missing platform manifest
  // during GitHub release transitions. Walk back once to the previous feed
  // entry so users on the last good build see a normal not-available result.
  pendingPrereleaseFallback.retryLaunched = true
  pendingPrereleaseFallback.userInitiated = Boolean(userInitiated)
  pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey =
    source === 'event' ? failureKey : null
  pendingPrereleaseFallback.suppressedPrimaryEventFailure =
    source === 'promise' ? { failureKey, error: sourceError } : null
  pendingPrereleaseFallback.fallbackCheckingForUpdateSeen = false
  const { primaryTag, fallbackTag } = pendingPrereleaseFallback
  const url = getReleaseDownloadUrl(fallbackTag)
  console.info(
    `[updater] prerelease manifest missing for ${primaryTag}; retrying once against ${url}`
  )
  const autoUpdater = getAutoUpdater()
  autoUpdater.setFeedURL({ provider: 'generic', url })
  userInitiatedCheck = Boolean(userInitiated)
  backgroundCheckLaunchPending = !userInitiated
  void autoUpdater.checkForUpdates().catch((err) => {
    const message = String(err?.message ?? err)
    if (userInitiated) {
      userInitiatedCheck = false
    } else {
      backgroundCheckLaunchPending = false
    }
    markMissingManifestPrereleaseFallbackPromiseHandled(message)
    consumeMissingManifestPrereleaseFallbackResult()
    void sendCheckFailureStatus(message, userInitiated, 'fallback-promise', err)
  })
  return true
}

function runBackgroundUpdateCheck(
  nudgeId: string | null = getPersistedPendingUpdateNudgeId()
): void {
  if (backgroundCheckLaunchPending || currentStatus.state === 'checking') {
    return
  }
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available' })
    return
  }
  // Why: scope the nudge marker to the updater cycle being launched right now.
  // Setting it here, before any updater events or rejected promises can arrive,
  // prevents later ordinary checks from inheriting an older campaign id. Use
  // the persisted pending id for ordinary background checks so a nudge-driven
  // card can still be dismissed correctly after relaunch or a later 24h check.
  activeUpdateNudgeId = nudgeId
  // Why: autoUpdater.checkForUpdates() is async and 'checking-for-update'
  // arrives on a later tick, so a second focus/resume event can slip in before
  // currentStatus flips to 'checking'. Track the launch in memory to dedupe
  // that gap without persisting a successful-check timestamp before the result.
  backgroundCheckLaunchPending = true
  // Don't send 'checking' here — the 'checking-for-update' event handler does it,
  // and sending it from both places causes duplicate notifications (issue #35).
  const autoUpdater = getAutoUpdater()
  const launch = (): Promise<unknown> => autoUpdater.checkForUpdates()
  const run = pinDefaultReleaseFeed().then(launch)
  void Promise.resolve(run).catch((err) => {
    backgroundCheckLaunchPending = false
    void sendCheckFailureStatus(String(err?.message ?? err), undefined, 'promise', err)
  })
}

export function checkForUpdates(): void {
  runBackgroundUpdateCheck()
}

function enableIncludePrerelease(): void {
  if (includePrereleaseActive) {
    return
  }
  // Why: generic-provider checks still need this flag so electron-updater will
  // accept a prerelease manifest for users who intentionally Shift-clicked.
  // We keep using the manifest-probed generic feed instead of the native
  // GitHub provider because cancelled RC releases can appear without assets.
  getAutoUpdater().allowPrerelease = true
  includePrereleaseActive = true
}

/** Menu-triggered check — delegates feedback to renderer toasts via userInitiated flag */
export function checkForUpdatesFromMenu(options?: { includePrerelease?: boolean }): void {
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available', userInitiated: true })
    return
  }

  if (options?.includePrerelease) {
    clearPrereleaseFallbackContext()
    enableIncludePrerelease()
  }

  userInitiatedCheck = true
  // Why: a manual check is independent of any active nudge campaign. Reset the
  // nudge marker so the resulting status is not decorated with activeNudgeId,
  // which would cause a later dismiss to consume the campaign by accident.
  activeUpdateNudgeId = null
  // Don't send 'checking' here — the 'checking-for-update' event handler does it,
  // and sending it from both places causes duplicate notifications (issue #35).

  const autoUpdater = getAutoUpdater()
  const launch = (): Promise<unknown> => autoUpdater.checkForUpdates()
  const run = pinDefaultReleaseFeed().then(launch)
  void Promise.resolve(run).catch((err) => {
    userInitiatedCheck = false
    void sendCheckFailureStatus(String(err?.message ?? err), true, 'promise', err)
  })
}

export function isQuittingForUpdate(): boolean {
  return quittingForUpdate
}

export function quitAndInstall(): void {
  if (
    pendingQuitAndInstallTimer ||
    currentStatus.state === 'preparing' ||
    currentStatus.state === 'installing' ||
    currentStatus.state === 'restarting'
  ) {
    return
  }

  if (
    deferMacQuitUntilInstallerReady(
      currentStatus,
      hasNewerDownloadedVersion(),
      getPendingInstallVersion,
      sendStatus
    )
  ) {
    return
  }

  const targetVersion = getPendingInstallVersion()
  if (!targetVersion || compareVersions(targetVersion, app.getVersion()) <= 0) {
    sendErrorStatus('No staged update is ready to install.')
    return
  }

  const marker = persistUpdateInstallAttemptMarker(targetVersion, { reusePendingAttempt: true })
  if (!marker) {
    return
  }

  // Why: every renderer entrypoint reaches this IPC handler from an in-flight
  // click or toast callback. Deferring the actual quit here gives the renderer
  // a moment to flush dismissals/state updates before windows start closing,
  // and centralizing it avoids drift between the toast flow and settings UI.
  pendingQuitAndInstallTimer = setTimeout(() => {
    performQuitAndInstall(marker)
  }, QUIT_AND_INSTALL_DELAY_MS)
}

async function checkForUpdateNudge(): Promise<void> {
  if (!app.isPackaged || is.dev) {
    return
  }
  if (nudgeCheckInFlight) {
    return
  }

  const now = Date.now()
  if (now - lastNudgeCheckAt < NUDGE_ACTIVATION_COOLDOWN_MS) {
    return
  }
  lastNudgeCheckAt = now

  nudgeCheckInFlight = true
  try {
    const nudge = await fetchNudge()
    if (!nudge) {
      return
    }

    if (currentStatus.state === 'checking' || currentStatus.state === 'downloading') {
      return
    }

    const appVersion = app.getVersion()
    const pendingUpdateNudgeId = _getPendingUpdateNudgeId?.() ?? null
    const dismissedUpdateNudgeId = _getDismissedUpdateNudgeId?.() ?? null

    if (
      shouldApplyNudge({
        nudge,
        appVersion,
        pendingUpdateNudgeId,
        dismissedUpdateNudgeId
      })
    ) {
      awaitingNudgeCheckOutcome = true
      _setPendingUpdateNudgeId?.(nudge.id)
      mainWindowRef?.webContents.send('updater:clearDismissal')
      runBackgroundUpdateCheck(nudge.id)
    }
  } finally {
    nudgeCheckInFlight = false
  }
}

function scheduleUpdateNudgeCheck(): void {
  if (nudgeCheckTimer) {
    clearTimeout(nudgeCheckTimer)
  }
  nudgeCheckTimer = setTimeout(() => {
    void checkForUpdateNudge()
    scheduleUpdateNudgeCheck()
  }, NUDGE_POLL_INTERVAL_MS)
}

export function dismissNudge(): void {
  const pendingId = activeUpdateNudgeId ?? _getPendingUpdateNudgeId?.() ?? null
  if (pendingId) {
    _setDismissedUpdateNudgeId?.(pendingId)
    clearPendingUpdateNudge()
  }
}

export function setupAutoUpdater(
  mainWindow: BrowserWindow,
  opts?: {
    getLastUpdateCheckAt?: () => number | null
    onBeforeQuit?: () => void
    setLastUpdateCheckAt?: (timestamp: number) => void
    getPendingUpdateNudgeId?: () => string | null
    getDismissedUpdateNudgeId?: () => string | null
    setPendingUpdateNudgeId?: (id: string | null) => void
    setDismissedUpdateNudgeId?: (id: string | null) => void
  }
): void {
  mainWindowRef = mainWindow
  onBeforeQuitCleanup = opts?.onBeforeQuit ?? null
  persistLastUpdateCheckAt = opts?.setLastUpdateCheckAt ?? null
  _getLastUpdateCheckAt = opts?.getLastUpdateCheckAt ?? null
  _getPendingUpdateNudgeId = opts?.getPendingUpdateNudgeId ?? null
  _getDismissedUpdateNudgeId = opts?.getDismissedUpdateNudgeId ?? null
  _setPendingUpdateNudgeId = opts?.setPendingUpdateNudgeId ?? null
  _setDismissedUpdateNudgeId = opts?.setDismissedUpdateNudgeId ?? null

  initializeInstallRecoveryState()

  if (!app.isPackaged && !is.dev) {
    return
  }
  if (is.dev) {
    return
  }

  const autoUpdater = getAutoUpdater()
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // Why: the only on-machine window we have into electron-updater. Without
  // this, an unexpected `update-not-available` (e.g. RC user not offered
  // newer stable) is invisible — we can't tell whether the manifest fetch
  // got the wrong version, the request failed, or a stale in-flight check
  // was deduped. Logs go to main-process stdout, captured on macOS by
  // Console.app under the app bundle, and on Win/Linux by --enable-logging.
  autoUpdater.logger = {
    info: (m: unknown) => console.info('[autoUpdater]', m),
    warn: (m: unknown) => console.warn('[autoUpdater]', m),
    error: (m: unknown) => console.error('[autoUpdater]', m),
    debug: (m: unknown) => console.debug('[autoUpdater]', m)
  } as never

  // Why: no Windows Authenticode certificate exists for this project.
  // electron-builder embeds the code-signing publisherName into the app's
  // bundled app-update.yml at build time. Versions that were incorrectly
  // signed with the macOS Apple Developer ID cert (issue #631) baked in a
  // publisherName whose chain Windows cannot validate, and even after the
  // CI fix the installed app's app-update.yml still contains the stale
  // publisherName. Skip Windows code signing verification — update
  // integrity is still guaranteed by the SHA-512 hash check in latest.yml.
  //
  // TODO: remove this override once a Windows Authenticode certificate is
  // purchased and WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD are added to CI.
  // At that point electron-builder will embed the correct publisherName
  // and the default verification should be re-enabled.
  if (process.platform === 'win32') {
    ;(autoUpdater as NsisUpdater).verifyUpdateCodeSignature = () => Promise.resolve(null)
  }

  // Use the generic provider with GitHub's /releases/latest/download/ URL as
  // the startup fallback so electron-updater can fetch the manifest
  // (latest-mac.yml, latest.yml, latest-linux.yml) from the latest
  // non-prerelease release.
  //
  // Why: before each default-channel check we repin this URL to a concrete
  // /releases/download/<tag>/ URL. Keeping the generic provider avoids the
  // native GitHub provider's RC channel filtering, and pinning avoids the
  // moving /latest redirect changing between check and download.
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'https://github.com/stablyai/orca/releases/latest/download'
  })

  if (autoUpdaterInitialized) {
    return
  }
  autoUpdaterInitialized = true

  registerAutoUpdaterHandlers({
    autoUpdater,
    clearAvailableUpdateContext,
    consumeMissingManifestPrereleaseFallbackResult,
    getMissingManifestPrereleaseFallbackUserInitiated,
    getCurrentStatus: () => currentStatus,
    getKnownReleaseUrl,
    getPendingInstallVersion,
    getUserInitiatedCheck: () => userInitiatedCheck,
    hasNewerDownloadedVersion,
    hasPendingQuitAndInstall: () => pendingQuitAndInstallTimer !== null,
    performQuitAndInstall,
    sendCheckFailureStatus,
    sendErrorStatus,
    markMissingManifestPrereleaseFallbackChecking,
    shouldSuppressMissingManifestPrereleaseFallbackEvent,
    suppressMissingManifestPrereleaseFallbackPromiseFailure,
    recordCompletedUpdateCheck,
    sendStatus,
    scheduleAutomaticUpdateCheck,
    clearBackgroundCheckLaunchPending,
    setAvailableReleaseUrl: (releaseUrl) => {
      availableReleaseUrl = releaseUrl
    },
    setAvailableUpdateChecksum: (checksum) => {
      availableUpdateChecksum = checksum
    },
    setAvailableVersion: (version) => {
      availableVersion = version
    },
    setUserInitiatedCheck: (value) => {
      userInitiatedCheck = value
    }
  })

  void checkForUpdateNudge()
  scheduleUpdateNudgeCheck()

  if (currentStatus.state === 'recovery') {
    return
  }

  const checkDailyOnWake = () => {
    void checkForUpdateNudge()
    if (
      backgroundCheckLaunchPending ||
      currentStatus.state === 'checking' ||
      currentStatus.state === 'downloading'
    ) {
      return
    }
    const lastCheck = _getLastUpdateCheckAt?.() ?? null
    const msSince = lastCheck === null ? Number.POSITIVE_INFINITY : Date.now() - lastCheck
    if (msSince >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
      runBackgroundUpdateCheck()
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
    }
  }

  powerMonitor.on('resume', checkDailyOnWake)
  app.on('browser-window-focus', checkDailyOnWake)

  const lastUpdateCheckAt = opts?.getLastUpdateCheckAt?.() ?? null
  const msSinceLastCheck =
    lastUpdateCheckAt === null ? Number.POSITIVE_INFINITY : Date.now() - lastUpdateCheckAt

  if (msSinceLastCheck >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
    runBackgroundUpdateCheck()
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
  } else {
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS - msSinceLastCheck)
  }
}

export function downloadUpdate(): void {
  if (downloadInFlight) {
    return
  }
  // Why: permit retry from 'error' when we still have a cached availableVersion —
  // a failed download leaves the status at 'error' but availableVersion intact,
  // and the error card's "Retry Download" button must be able to restart the
  // download. Without this, the button would appear to do nothing.
  const canStart =
    currentStatus.state === 'available' ||
    (currentStatus.state === 'recovery' && currentStatus.targetVersion !== null) ||
    (currentStatus.state === 'error' && hasNewerDownloadedVersion())
  if (!canStart) {
    return
  }
  const recoveryRetryVersion =
    currentStatus.state === 'recovery' && currentStatus.targetVersion !== null
      ? currentStatus.targetVersion
      : null
  if (
    recoveryRetryVersion &&
    !persistUpdateInstallAttemptMarker(recoveryRetryVersion, { reusePendingAttempt: false })
  ) {
    return
  }
  downloadInFlight = true
  beginMacUpdateDownload()
  const autoUpdater = getAutoUpdater()
  const prepareDownload = recoveryRetryVersion
    ? Promise.resolve()
        .then(() => {
          // Why: after a relaunch recovery is reconstructed from disk, but
          // electron-updater's in-memory update info is empty. Re-check the
          // exact failed target before downloading so the provider is hydrated.
          pinReleaseFeedToVersion(recoveryRetryVersion)
          return autoUpdater.checkForUpdates()
        })
        .then(() => {
          // Why: the check event clears availableVersion, and the async
          // changelog path may not restore it before download progress starts.
          availableVersion = recoveryRetryVersion
        })
    : Promise.resolve()
  prepareDownload
    .then(() => autoUpdater.downloadUpdate())
    .catch((err) => {
      downloadInFlight = false
      sendErrorStatus(String(err?.message ?? err))
    })
}
