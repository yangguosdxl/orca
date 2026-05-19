import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  observeMacShipItInstall,
  recordMacShipItInstallObservation,
  shouldQuitRelaunchedAppDuringMacUpdate
} from './mac-update-relaunch-guard'
import {
  createUpdateInstallMarker,
  getUpdateInstallMarkerPath,
  readUpdateInstallMarker,
  writeUpdateInstallMarker
} from './update-install-marker'

describe('mac update relaunch guard', () => {
  const appBundlePath = '/Applications/Orca.app'
  const installingShipItCommand =
    '/Applications/Orca.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt'

  it('quits the old app when relaunched while ShipIt is installing a newer bundle', () => {
    expect(
      shouldQuitRelaunchedAppDuringMacUpdate({
        appBundlePath,
        appVersion: '1.4.4-rc.0',
        platform: 'darwin',
        shipItProcessCommands: [installingShipItCommand],
        shipItState: {
          targetBundleURL: 'file:///Applications/Orca.app/',
          updateBundleURL:
            'file:///Users/me/Library/Caches/com.stablyai.orca.ShipIt/update/Orca.app/'
        },
        updateBundleVersion: '1.4.6'
      })
    ).toBe(true)
  })

  it('allows the relaunched app after the installed bundle is already current', () => {
    expect(
      shouldQuitRelaunchedAppDuringMacUpdate({
        appBundlePath,
        appVersion: '1.4.6',
        platform: 'darwin',
        shipItProcessCommands: [installingShipItCommand],
        shipItState: {
          targetBundleURL: 'file:///Applications/Orca.app/',
          updateBundleURL:
            'file:///Users/me/Library/Caches/com.stablyai.orca.ShipIt/update/Orca.app/'
        },
        updateBundleVersion: '1.4.6'
      })
    ).toBe(false)
  })

  it('does not react to stale ShipIt state when no installer is running', () => {
    expect(
      shouldQuitRelaunchedAppDuringMacUpdate({
        appBundlePath,
        appVersion: '1.4.4-rc.0',
        platform: 'darwin',
        shipItProcessCommands: [],
        shipItState: {
          targetBundleURL: 'file:///Applications/Orca.app/',
          updateBundleURL:
            'file:///Users/me/Library/Caches/com.stablyai.orca.ShipIt/update/Orca.app/'
        },
        updateBundleVersion: '1.4.6'
      })
    ).toBe(false)
  })

  it('does not react to installs targeting a different duplicate app bundle', () => {
    expect(
      shouldQuitRelaunchedAppDuringMacUpdate({
        appBundlePath,
        appVersion: '1.4.4-rc.0',
        platform: 'darwin',
        shipItProcessCommands: [
          '/Applications/Orca 2.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt'
        ],
        shipItState: {
          targetBundleURL: 'file:///Applications/Orca%202.app/',
          updateBundleURL:
            'file:///Users/me/Library/Caches/com.stablyai.orca.ShipIt/update/Orca.app/'
        },
        updateBundleVersion: '1.4.6'
      })
    ).toBe(false)
  })

  it('rejects ShipIt matches that disagree with the persisted staged identity', () => {
    expect(
      shouldQuitRelaunchedAppDuringMacUpdate({
        appBundlePath,
        appVersion: '1.4.4-rc.0',
        platform: 'darwin',
        shipItProcessCommands: [installingShipItCommand],
        shipItState: {
          targetBundleURL: 'file:///Applications/Orca.app/',
          updateBundleURL:
            'file:///Users/me/Library/Caches/com.stablyai.orca.ShipIt/update/Orca.app/'
        },
        updateBundleVersion: '1.4.6',
        marker: {
          schemaVersion: 1,
          attemptId: 'attempt-1',
          platform: 'darwin',
          currentVersion: '1.4.4-rc.0',
          targetVersion: '1.4.6',
          stagedUpdateIdentity: {
            kind: 'mac-squirrel',
            targetVersion: '1.4.6',
            targetBundleURL: 'file:///Applications/Orca.app/',
            updateBundleURL:
              'file:///Users/me/Library/Caches/com.stablyai.orca.ShipIt/other/Orca.app/',
            updateBundleVersion: '1.4.6',
            updateChecksum: null,
            releaseUrl: null
          },
          startedAt: 1,
          lastObservedAt: 1,
          installDeadlineAt: 2,
          staleAfter: 3,
          installState: 'restarting'
        }
      })
    ).toBe(false)
  })

  it('returns the matching ShipIt pid for marker observation', () => {
    expect(
      observeMacShipItInstall({
        appBundlePath,
        appVersion: '1.4.4-rc.0',
        platform: 'darwin',
        shipItProcesses: [{ pid: 42, command: installingShipItCommand }],
        shipItState: {
          targetBundleURL: 'file:///Applications/Orca.app/',
          updateBundleURL:
            'file:///Users/me/Library/Caches/com.stablyai.orca.ShipIt/update/Orca.app/'
        },
        updateBundleVersion: '1.4.6'
      })
    ).toMatchObject({
      confidence: 'high',
      shipItPid: 42,
      reason: 'matching-shipit-process'
    })
  })

  it('records a high-confidence ShipIt observation on the persisted marker', () => {
    const markerPath = getUpdateInstallMarkerPath(mkdtempSync(join(tmpdir(), 'orca-mac-guard-')))
    const marker = createUpdateInstallMarker({
      currentVersion: '1.4.4-rc.0',
      targetVersion: '1.4.6',
      platform: 'darwin',
      stagedUpdateIdentity: null,
      now: 1_000
    })
    writeUpdateInstallMarker(markerPath, marker)

    const next = recordMacShipItInstallObservation(markerPath, marker, {
      confidence: 'high',
      reason: 'matching-shipit-process',
      shipItPid: 42,
      shipItState: {
        targetBundleURL: 'file:///Applications/Orca.app/',
        updateBundleURL: 'file:///Users/me/Library/Caches/com.stablyai.orca.ShipIt/update/Orca.app/'
      },
      updateBundleVersion: '1.4.6'
    })

    expect(next).toMatchObject({
      attemptId: marker.attemptId,
      shipItPid: 42
    })
    expect(readUpdateInstallMarker(markerPath)).toMatchObject({
      attemptId: marker.attemptId,
      shipItPid: 42
    })
  })
})
