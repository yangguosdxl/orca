/* eslint-disable max-lines -- Why: marker validation, atomic persistence, and
   recovery decisions must stay together so schema changes do not drift from the
   startup/install state machine they protect. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { compareVersions } from './updater-fallback'

export const UPDATE_INSTALL_DEADLINE_MS = 10 * 60 * 1000
export const UPDATE_INSTALL_STALE_AFTER_MS = 24 * 60 * 60 * 1000

const MARKER_SCHEMA_VERSION = 1
const MARKER_FILE_NAME = 'update-install-marker.json'

export type UpdateInstallMarkerState = 'preparing' | 'installing' | 'restarting' | 'recovery'

export type UpdateStagedIdentity =
  | {
      kind: 'mac-squirrel'
      targetVersion: string
      targetBundleURL: string | null
      updateBundleURL: string | null
      updateBundleVersion: string | null
      updateChecksum: string | null
      releaseUrl: string | null
    }
  | {
      kind: 'electron-updater'
      targetVersion: string
      releaseUrl: string | null
    }

export type UpdateInstallMarker = {
  schemaVersion: 1
  attemptId: string
  platform: NodeJS.Platform
  currentVersion: string
  targetVersion: string
  stagedUpdateIdentity: UpdateStagedIdentity | null
  startedAt: number
  lastObservedAt: number
  installDeadlineAt: number
  staleAfter: number
  shipItPid?: number
  installState: UpdateInstallMarkerState
  failureReason?: string
}

export type UpdateInstallRecoveryDecision =
  | { action: 'none' }
  | { action: 'installer-active'; marker: UpdateInstallMarker }
  | { action: 'clear'; reason: 'updated' | 'stale-success' }
  | { action: 'recovery'; reason: string; marker: UpdateInstallMarker; shouldClearMarker: boolean }

export type UpdateInstallMarkerReadResult =
  | { status: 'missing' }
  | { status: 'valid'; marker: UpdateInstallMarker }
  | { status: 'invalid'; reason: string }

export function getUpdateInstallMarkerPath(userDataPath: string): string {
  return join(userDataPath, MARKER_FILE_NAME)
}

export function createUpdateInstallMarker(args: {
  currentVersion: string
  targetVersion: string
  platform: NodeJS.Platform
  stagedUpdateIdentity: UpdateStagedIdentity | null
  now?: number
}): UpdateInstallMarker {
  const now = args.now ?? Date.now()
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    attemptId: randomUUID(),
    platform: args.platform,
    currentVersion: args.currentVersion,
    targetVersion: args.targetVersion,
    stagedUpdateIdentity: args.stagedUpdateIdentity,
    startedAt: now,
    lastObservedAt: now,
    installDeadlineAt: now + UPDATE_INSTALL_DEADLINE_MS,
    staleAfter: now + UPDATE_INSTALL_STALE_AFTER_MS,
    installState: 'preparing'
  }
}

export function readUpdateInstallMarker(markerPath: string): UpdateInstallMarker | null {
  const result = readUpdateInstallMarkerResult(markerPath)
  return result.status === 'valid' ? result.marker : null
}

export function readUpdateInstallMarkerResult(markerPath: string): UpdateInstallMarkerReadResult {
  if (!existsSync(markerPath)) {
    return { status: 'missing' }
  }

  try {
    return {
      status: 'valid',
      marker: validateUpdateInstallMarker(JSON.parse(readFileSync(markerPath, 'utf8')))
    }
  } catch (error) {
    return { status: 'invalid', reason: String(error) }
  }
}

export function writeUpdateInstallMarker(markerPath: string, marker: UpdateInstallMarker): void {
  const directory = dirname(markerPath)
  mkdirSync(directory, { recursive: true })
  const tempPath = join(directory, `.${MARKER_FILE_NAME}.${process.pid}.${marker.attemptId}.tmp`)
  const payload = `${JSON.stringify(marker, null, 2)}\n`
  const file = openSync(tempPath, 'w', 0o600)
  try {
    writeFileSync(file, payload, 'utf8')
    fsyncSync(file)
  } finally {
    closeSync(file)
  }
  renameSync(tempPath, markerPath)
  flushDirectory(directory)
}

export function updateInstallMarkerState(
  markerPath: string,
  marker: UpdateInstallMarker,
  installState: UpdateInstallMarkerState,
  now = Date.now(),
  failureReason?: string
): UpdateInstallMarker {
  const next: UpdateInstallMarker = {
    ...marker,
    installState,
    lastObservedAt: now,
    ...(failureReason ? { failureReason } : {})
  }
  writeUpdateInstallMarker(markerPath, next)
  return next
}

export function updateInstallMarkerObservation(
  markerPath: string,
  marker: UpdateInstallMarker,
  args: {
    now?: number
    shipItPid?: number
  }
): UpdateInstallMarker {
  const next: UpdateInstallMarker = {
    ...marker,
    lastObservedAt: args.now ?? Date.now(),
    ...(args.shipItPid === undefined ? {} : { shipItPid: args.shipItPid })
  }
  writeUpdateInstallMarker(markerPath, next)
  return next
}

export function clearUpdateInstallMarker(markerPath: string): void {
  rmSync(markerPath, { force: true })
}

export function evaluateUpdateInstallMarker(args: {
  marker: UpdateInstallMarker | null
  runningVersion: string
  platform: NodeJS.Platform
  installerActive: boolean
  now?: number
}): UpdateInstallRecoveryDecision {
  if (!args.marker) {
    return { action: 'none' }
  }

  const now = args.now ?? Date.now()
  if (compareVersions(args.runningVersion, args.marker.targetVersion) >= 0) {
    return { action: 'clear', reason: 'updated' }
  }
  if (compareVersions(args.runningVersion, args.marker.currentVersion) > 0) {
    return { action: 'clear', reason: 'stale-success' }
  }
  if (args.marker.platform !== args.platform) {
    return {
      action: 'recovery',
      reason: 'platform-changed',
      marker: args.marker,
      shouldClearMarker: true
    }
  }
  if (now > args.marker.staleAfter) {
    return {
      action: 'recovery',
      reason: 'stale-marker',
      marker: args.marker,
      shouldClearMarker: true
    }
  }
  if (args.installerActive) {
    return { action: 'installer-active', marker: args.marker }
  }
  if (now > args.marker.installDeadlineAt) {
    return {
      action: 'recovery',
      reason: 'install-deadline-expired',
      marker: args.marker,
      shouldClearMarker: false
    }
  }

  return {
    action: 'recovery',
    reason: 'restarted-before-update-completed',
    marker: args.marker,
    shouldClearMarker: false
  }
}

function validateUpdateInstallMarker(value: unknown): UpdateInstallMarker {
  if (!isRecord(value)) {
    throw new Error('marker is not an object')
  }
  if (value.schemaVersion !== MARKER_SCHEMA_VERSION) {
    throw new Error('unsupported schemaVersion')
  }

  const marker: UpdateInstallMarker = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    attemptId: requireString(value.attemptId, 'attemptId'),
    platform: requirePlatform(value.platform),
    currentVersion: requireVersion(value.currentVersion, 'currentVersion'),
    targetVersion: requireVersion(value.targetVersion, 'targetVersion'),
    stagedUpdateIdentity: requireStagedIdentity(value.stagedUpdateIdentity),
    startedAt: requireTimestamp(value.startedAt, 'startedAt'),
    lastObservedAt: requireTimestamp(value.lastObservedAt, 'lastObservedAt'),
    installDeadlineAt: requireTimestamp(value.installDeadlineAt, 'installDeadlineAt'),
    staleAfter: requireTimestamp(value.staleAfter, 'staleAfter'),
    installState: requireInstallState(value.installState),
    ...(value.shipItPid === undefined ? {} : { shipItPid: requirePid(value.shipItPid) }),
    ...(value.failureReason === undefined
      ? {}
      : { failureReason: requireString(value.failureReason, 'failureReason') })
  }

  if (marker.installDeadlineAt < marker.startedAt || marker.staleAfter < marker.startedAt) {
    throw new Error('marker timestamps are inconsistent')
  }
  return marker
}

function requireStagedIdentity(value: unknown): UpdateStagedIdentity | null {
  if (value === null) {
    return null
  }
  if (!isRecord(value)) {
    throw new Error('stagedUpdateIdentity must be null or an object')
  }
  const kind = value.kind
  if (kind !== 'mac-squirrel' && kind !== 'electron-updater') {
    throw new Error('invalid stagedUpdateIdentity.kind')
  }
  if (kind === 'mac-squirrel') {
    return {
      kind,
      targetVersion: requireVersion(value.targetVersion, 'stagedUpdateIdentity.targetVersion'),
      targetBundleURL: requireNullableString(
        value.targetBundleURL,
        'stagedUpdateIdentity.targetBundleURL'
      ),
      updateBundleURL: requireNullableString(
        value.updateBundleURL,
        'stagedUpdateIdentity.updateBundleURL'
      ),
      updateBundleVersion: requireNullableVersion(
        value.updateBundleVersion,
        'stagedUpdateIdentity.updateBundleVersion'
      ),
      updateChecksum: requireNullableString(
        value.updateChecksum,
        'stagedUpdateIdentity.updateChecksum'
      ),
      releaseUrl: requireNullableString(value.releaseUrl, 'stagedUpdateIdentity.releaseUrl')
    }
  }
  return {
    kind,
    targetVersion: requireVersion(value.targetVersion, 'stagedUpdateIdentity.targetVersion'),
    releaseUrl: requireNullableString(value.releaseUrl, 'stagedUpdateIdentity.releaseUrl')
  }
}

function requireInstallState(value: unknown): UpdateInstallMarkerState {
  if (
    value === 'preparing' ||
    value === 'installing' ||
    value === 'restarting' ||
    value === 'recovery'
  ) {
    return value
  }
  throw new Error('invalid installState')
}

function requirePlatform(value: unknown): NodeJS.Platform {
  if (
    value === 'aix' ||
    value === 'android' ||
    value === 'darwin' ||
    value === 'freebsd' ||
    value === 'haiku' ||
    value === 'linux' ||
    value === 'openbsd' ||
    value === 'sunos' ||
    value === 'win32' ||
    value === 'cygwin' ||
    value === 'netbsd'
  ) {
    return value
  }
  throw new Error('invalid platform')
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${field}`)
  }
  return value
}

function requirePid(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('invalid shipItPid')
  }
  return value
}

function requireVersion(value: unknown, field: string): string {
  const version = requireString(value, field)
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid ${field}`)
  }
  return version
}

function requireNullableVersion(value: unknown, field: string): string | null {
  if (value === null) {
    return null
  }
  return requireVersion(value, field)
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null
  }
  return requireString(value, field)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid ${field}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flushDirectory(directory: string): void {
  if (process.platform === 'win32') {
    return
  }
  let fd: number | null = null
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
  } catch {
    // Best-effort: Windows and some filesystems do not support directory fsync.
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}
