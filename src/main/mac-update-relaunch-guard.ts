/* eslint-disable max-lines -- Why: ShipIt state, process matching, and early
   self-quit protection are one safety boundary; splitting them would make the
   high-confidence contract harder to audit. */
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join, normalize } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { app, Notification } from 'electron'
import { compareVersions } from './updater-fallback'
import {
  getUpdateInstallMarkerPath,
  readUpdateInstallMarker,
  updateInstallMarkerObservation,
  type UpdateInstallMarker
} from './update-install-marker'

const ORCA_BUNDLE_ID = 'com.stablyai.orca'

export type MacUpdateRelaunchGuardArgs = {
  appBundlePath: string
  appVersion: string
  platform: NodeJS.Platform
  shipItProcessCommands?: string[]
  shipItProcesses?: MacShipItProcess[]
  shipItState: {
    targetBundleURL: string | null
    updateBundleURL: string | null
  } | null
  updateBundleVersion: string | null
  marker?: UpdateInstallMarker | null
}

export type MacShipItState = NonNullable<MacUpdateRelaunchGuardArgs['shipItState']>

export type MacShipItProcess = {
  pid: number
  command: string
}

export type MacShipItInstallObservation = {
  confidence: 'high' | 'low'
  reason: string
  shipItPid?: number
  shipItState: MacShipItState | null
  updateBundleVersion: string | null
}

export function shouldQuitRelaunchedAppDuringMacUpdate({
  appBundlePath,
  appVersion,
  platform,
  shipItProcessCommands,
  shipItProcesses,
  shipItState,
  updateBundleVersion,
  marker
}: MacUpdateRelaunchGuardArgs): boolean {
  return (
    observeMacShipItInstall({
      appBundlePath,
      appVersion,
      platform,
      shipItProcesses:
        shipItProcesses ??
        (shipItProcessCommands ?? []).map((command, index) => ({ pid: index + 1, command })),
      shipItState,
      updateBundleVersion,
      marker
    }).confidence === 'high'
  )
}

export function observeMacShipItInstall({
  appBundlePath,
  appVersion,
  platform,
  shipItProcesses,
  shipItState,
  updateBundleVersion,
  marker
}: {
  appBundlePath: string
  appVersion: string
  platform: NodeJS.Platform
  shipItProcesses: MacShipItProcess[]
  shipItState: MacShipItState | null
  updateBundleVersion: string | null
  marker?: UpdateInstallMarker | null
}): MacShipItInstallObservation {
  if (platform !== 'darwin' || !shipItState?.targetBundleURL || !shipItState.updateBundleURL) {
    return {
      confidence: 'low',
      reason: 'missing-shipit-state',
      shipItState,
      updateBundleVersion
    }
  }

  if (!pathsEqual(fileUrlToPath(shipItState.targetBundleURL), appBundlePath)) {
    return {
      confidence: 'low',
      reason: 'target-bundle-mismatch',
      shipItState,
      updateBundleVersion
    }
  }

  if (!updateBundleVersion || compareVersions(updateBundleVersion, appVersion) <= 0) {
    return {
      confidence: 'low',
      reason: 'update-version-not-newer',
      shipItState,
      updateBundleVersion
    }
  }

  if (marker) {
    if (compareVersions(updateBundleVersion, marker.targetVersion) !== 0) {
      return {
        confidence: 'low',
        reason: 'marker-target-version-mismatch',
        shipItState,
        updateBundleVersion
      }
    }
    if (!macStagedIdentityMatches(marker, shipItState, updateBundleVersion)) {
      return {
        confidence: 'low',
        reason: 'marker-staged-identity-mismatch',
        shipItState,
        updateBundleVersion
      }
    }
  }

  const shipItPath = join(appBundlePath, 'Contents', 'Frameworks', 'Squirrel.framework')
  const process = shipItProcesses.find(({ command }) => command.includes(shipItPath))
  if (!process) {
    return {
      confidence: 'low',
      reason: 'shipit-process-not-running',
      shipItState,
      updateBundleVersion
    }
  }

  return {
    confidence: 'high',
    reason: 'matching-shipit-process',
    shipItPid: process.pid,
    shipItState,
    updateBundleVersion
  }
}

export function getCurrentMacShipItInstallIdentity(): {
  targetBundleURL: string | null
  updateBundleURL: string | null
  updateBundleVersion: string | null
} | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const shipItState = readShipItState()
  if (!shipItState) {
    return null
  }
  const updateBundlePath = shipItState.updateBundleURL
    ? fileUrlToPath(shipItState.updateBundleURL)
    : null
  return {
    ...shipItState,
    updateBundleVersion: updateBundlePath ? readBundleVersion(updateBundlePath) : null
  }
}

export function quitIfRelaunchedDuringMacUpdate(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return false
  }

  const appBundlePath = getMacAppBundlePath(process.execPath)
  if (!appBundlePath) {
    return false
  }

  const shipItState = readShipItState()
  const updateBundlePath = shipItState?.updateBundleURL
    ? fileUrlToPath(shipItState.updateBundleURL)
    : null
  const updateBundleVersion = updateBundlePath ? readBundleVersion(updateBundlePath) : null
  const markerPath = getUpdateInstallMarkerPath(app.getPath('userData'))
  const marker = readUpdateInstallMarker(markerPath)
  const observation = observeMacShipItInstall({
    appBundlePath,
    appVersion: app.getVersion(),
    platform: process.platform,
    shipItProcesses: listShipItProcesses(),
    shipItState,
    updateBundleVersion,
    marker
  })
  const shouldQuit = observation.confidence === 'high'

  if (shouldQuit) {
    recordMacShipItInstallObservation(markerPath, marker, observation)
    console.info(
      `[updater] Quitting stale app relaunch while ShipIt is installing update: pid=${observation.shipItPid ?? 'unknown'} reason=${observation.reason}`
    )
    showStillInstallingNotification()
    app.quit()
  }

  return shouldQuit
}

export function recordMacShipItInstallObservation(
  markerPath: string | null,
  marker: UpdateInstallMarker | null,
  observation: MacShipItInstallObservation
): UpdateInstallMarker | null {
  if (!markerPath || !marker || observation.confidence !== 'high') {
    return null
  }
  try {
    return updateInstallMarkerObservation(markerPath, marker, {
      shipItPid: observation.shipItPid
    })
  } catch (error) {
    console.warn(
      `[updater] failed to update install marker before stale-relaunch self-quit: attempt=${marker.attemptId} error=${String(error)}`
    )
    return null
  }
}

export function getMacAppBundlePath(execPath: string): string | null {
  const macOsDir = dirname(execPath)
  if (macOsDir.endsWith(join('Contents', 'MacOS'))) {
    return dirname(dirname(macOsDir))
  }
  return null
}

function readShipItState(): MacUpdateRelaunchGuardArgs['shipItState'] {
  const statePath = join(
    app.getPath('home'),
    'Library',
    'Caches',
    `${ORCA_BUNDLE_ID}.ShipIt`,
    'ShipItState.plist'
  )
  if (!existsSync(statePath)) {
    return null
  }

  return {
    targetBundleURL: readPlistValue(statePath, 'targetBundleURL'),
    updateBundleURL: readPlistValue(statePath, 'updateBundleURL')
  }
}

function readBundleVersion(bundlePath: string): string | null {
  return readPlistValue(join(bundlePath, 'Contents', 'Info.plist'), 'CFBundleShortVersionString')
}

function readPlistValue(plistPath: string, key: string): string | null {
  if (!existsSync(plistPath)) {
    return null
  }
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

export function listShipItProcesses(): MacShipItProcess[] {
  try {
    return execFileSync('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split('\n')
      .filter(Boolean)
      .map(parseProcessLine)
      .filter((process): process is MacShipItProcess => process !== null)
  } catch {
    return []
  }
}

function parseProcessLine(line: string): MacShipItProcess | null {
  const match = line.trim().match(/^(\d+)\s+(.+)$/)
  if (!match) {
    return null
  }
  return { pid: Number(match[1]), command: match[2] }
}

function macStagedIdentityMatches(
  marker: UpdateInstallMarker,
  shipItState: MacShipItState,
  updateBundleVersion: string
): boolean {
  const identity = marker.stagedUpdateIdentity
  if (identity?.kind !== 'mac-squirrel') {
    return true
  }
  if (identity.targetBundleURL && identity.targetBundleURL !== shipItState.targetBundleURL) {
    return false
  }
  if (identity.updateBundleURL && identity.updateBundleURL !== shipItState.updateBundleURL) {
    return false
  }
  if (identity.updateBundleVersion && identity.updateBundleVersion !== updateBundleVersion) {
    return false
  }
  return identity.targetVersion === marker.targetVersion
}

function showStillInstallingNotification(): void {
  try {
    if (!Notification.isSupported()) {
      return
    }
    new Notification({
      title: 'Orca is still installing',
      body: 'Orca will reopen automatically when the update finishes.'
    }).show()
  } catch {
    // Best-effort only; lack of notification permission must not block self-quit.
  }
}

function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') {
      return null
    }
    return fileURLToPath(url)
  } catch {
    return null
  }
}

function pathsEqual(left: string | null, right: string): boolean {
  if (!left) {
    return false
  }
  return (
    pathToFileURL(trimTrailingSeparators(normalize(left))).href ===
    pathToFileURL(trimTrailingSeparators(normalize(right))).href
  )
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}
