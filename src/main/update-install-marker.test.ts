import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  clearUpdateInstallMarker,
  createUpdateInstallMarker,
  evaluateUpdateInstallMarker,
  getUpdateInstallMarkerPath,
  readUpdateInstallMarker,
  readUpdateInstallMarkerResult,
  updateInstallMarkerObservation,
  updateInstallMarkerState,
  writeUpdateInstallMarker
} from './update-install-marker'

function markerPath(): string {
  return getUpdateInstallMarkerPath(mkdtempSync(join(tmpdir(), 'orca-update-marker-test-')))
}

describe('update install marker', () => {
  it('persists and validates an install attempt marker', () => {
    const path = markerPath()
    const marker = createUpdateInstallMarker({
      currentVersion: '1.4.4',
      targetVersion: '1.4.6',
      platform: 'darwin',
      stagedUpdateIdentity: {
        kind: 'mac-squirrel',
        targetVersion: '1.4.6',
        targetBundleURL: 'file:///Applications/Orca.app/',
        updateBundleURL:
          'file:///Users/me/Library/Caches/com.stablyai.orca.ShipIt/update/Orca.app/',
        updateBundleVersion: '1.4.6',
        updateChecksum: 'sha512-value',
        releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.6'
      },
      now: 1_000
    })

    writeUpdateInstallMarker(path, marker)

    expect(readUpdateInstallMarker(path)).toEqual(marker)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      attemptId: marker.attemptId,
      installState: 'preparing',
      currentVersion: '1.4.4',
      targetVersion: '1.4.6'
    })
  })

  it('updates state with attempt-scoped timestamps', () => {
    const path = markerPath()
    const marker = createUpdateInstallMarker({
      currentVersion: '1.4.4',
      targetVersion: '1.4.6',
      platform: 'darwin',
      stagedUpdateIdentity: null,
      now: 1_000
    })
    writeUpdateInstallMarker(path, marker)

    const next = updateInstallMarkerState(path, marker, 'installing', 2_000)

    expect(next).toMatchObject({ attemptId: marker.attemptId, installState: 'installing' })
    expect(readUpdateInstallMarker(path)).toMatchObject({
      attemptId: marker.attemptId,
      installState: 'installing',
      lastObservedAt: 2_000
    })
  })

  it('updates observed ShipIt pid without changing the attempt id', () => {
    const path = markerPath()
    const marker = createUpdateInstallMarker({
      currentVersion: '1.4.4',
      targetVersion: '1.4.6',
      platform: 'darwin',
      stagedUpdateIdentity: null,
      now: 1_000
    })
    writeUpdateInstallMarker(path, marker)

    const next = updateInstallMarkerObservation(path, marker, { now: 3_000, shipItPid: 42 })

    expect(next).toMatchObject({
      attemptId: marker.attemptId,
      shipItPid: 42,
      lastObservedAt: 3_000
    })
  })

  it('clears once the relaunched app reaches the target version', () => {
    const marker = createUpdateInstallMarker({
      currentVersion: '1.4.4',
      targetVersion: '1.4.6',
      platform: 'darwin',
      stagedUpdateIdentity: null,
      now: 1_000
    })

    expect(
      evaluateUpdateInstallMarker({
        marker,
        runningVersion: '1.4.6',
        platform: 'darwin',
        installerActive: false,
        now: 2_000
      })
    ).toEqual({ action: 'clear', reason: 'updated' })
  })

  it('enters recovery when the old app restarts after the install deadline', () => {
    const marker = createUpdateInstallMarker({
      currentVersion: '1.4.4',
      targetVersion: '1.4.6',
      platform: 'darwin',
      stagedUpdateIdentity: null,
      now: 1_000
    })

    expect(
      evaluateUpdateInstallMarker({
        marker,
        runningVersion: '1.4.4',
        platform: 'darwin',
        installerActive: false,
        now: marker.installDeadlineAt + 1
      })
    ).toMatchObject({
      action: 'recovery',
      reason: 'install-deadline-expired',
      shouldClearMarker: false
    })
  })

  it('keeps protecting startup while the native installer is still active', () => {
    const marker = createUpdateInstallMarker({
      currentVersion: '1.4.4',
      targetVersion: '1.4.6',
      platform: 'darwin',
      stagedUpdateIdentity: null,
      now: 1_000
    })

    expect(
      evaluateUpdateInstallMarker({
        marker,
        runningVersion: '1.4.4',
        platform: 'darwin',
        installerActive: true,
        now: marker.installDeadlineAt + 1
      })
    ).toMatchObject({
      action: 'installer-active',
      marker
    })
  })

  it('does not use macOS marker assumptions on other platforms', () => {
    const marker = createUpdateInstallMarker({
      currentVersion: '1.4.4',
      targetVersion: '1.4.6',
      platform: 'darwin',
      stagedUpdateIdentity: null,
      now: 1_000
    })

    expect(
      evaluateUpdateInstallMarker({
        marker,
        runningVersion: '1.4.4',
        platform: 'win32',
        installerActive: false,
        now: 2_000
      })
    ).toMatchObject({
      action: 'recovery',
      reason: 'platform-changed',
      shouldClearMarker: true
    })
  })

  it('removes the marker file when cleared', () => {
    const path = markerPath()
    const marker = createUpdateInstallMarker({
      currentVersion: '1.4.4',
      targetVersion: '1.4.6',
      platform: 'linux',
      stagedUpdateIdentity: null,
      now: 1_000
    })
    writeUpdateInstallMarker(path, marker)

    clearUpdateInstallMarker(path)

    expect(readUpdateInstallMarker(path)).toBeNull()
  })

  it('reports corrupt markers distinctly from missing markers', () => {
    const path = markerPath()
    writeFileSync(path, '{not-json', 'utf8')

    expect(readUpdateInstallMarkerResult(path)).toMatchObject({
      status: 'invalid'
    })
  })
})
