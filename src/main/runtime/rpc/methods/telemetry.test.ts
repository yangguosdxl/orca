// Coverage for the CLI-facing telemetry RPC method. Two invariants the
// system depends on:
//   1. A CLI-originated payload that names a non-CLI event is dropped
//      silently — the CLI must not be a privilege-escalation surface for
//      main-owned events (`agent_started`, `telemetry_opted_in`, etc.).
//   2. A schema-invalid payload is dropped without throwing — the CLI
//      gets back `{}` and never learns the request was rejected, so
//      telemetry health cannot leak through the wire shape.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TELEMETRY_METHODS } from './telemetry'
import { buildRegistry, type RpcContext } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'

const trackMock = vi.fn()
vi.mock('../../../telemetry/client', () => ({
  track: (name: string, props: unknown) => trackMock(name, props)
}))

describe('telemetry RPC methods', () => {
  let ctx: RpcContext

  beforeEach(() => {
    trackMock.mockReset()
    ctx = { runtime: new OrcaRuntimeService() }
  })

  afterEach(() => {
    trackMock.mockReset()
  })

  function findMethod(name: string) {
    const method = TELEMETRY_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  it('registers telemetry.captureCliEvent', () => {
    const registry = buildRegistry([...TELEMETRY_METHODS])
    expect(registry.has('telemetry.captureCliEvent')).toBe(true)
  })

  it('forwards a valid cli_feature_used payload to track()', async () => {
    await call('telemetry.captureCliEvent', {
      name: 'cli_feature_used',
      props: { feature_group: 'browser_observation', exit_status: 'success' }
    })
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('cli_feature_used', {
      feature_group: 'browser_observation',
      exit_status: 'success'
    })
  })

  // The narrow at the boundary: a compromised or buggy CLI must not be
  // able to emit main-owned events. Without this drop, the CLI's auth
  // token would let it ship `agent_started` / `telemetry_opted_in` /
  // anything else in the registry.
  it('drops non-CLI event names without calling track()', async () => {
    await call('telemetry.captureCliEvent', {
      name: 'agent_started',
      props: { agent_kind: 'claude-code', launch_source: 'sidebar', request_kind: 'new' }
    })
    await call('telemetry.captureCliEvent', {
      name: 'telemetry_opted_in',
      props: { via: 'first_launch_banner' }
    })
    await call('telemetry.captureCliEvent', {
      name: 'app_opened',
      props: {}
    })
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('drops schema-invalid props without calling track()', async () => {
    // Unknown feature_group
    await call('telemetry.captureCliEvent', {
      name: 'cli_feature_used',
      props: { feature_group: 'made_up_group', exit_status: 'success' }
    })
    // Missing exit_status
    await call('telemetry.captureCliEvent', {
      name: 'cli_feature_used',
      props: { feature_group: 'discovery' }
    })
    // Extra key (would leak free-form content if forwarded)
    await call('telemetry.captureCliEvent', {
      name: 'cli_feature_used',
      props: {
        feature_group: 'browser_navigation',
        exit_status: 'failure',
        error_message: 'ENOENT'
      }
    })
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('rejects an empty event name at the params boundary', () => {
    const method = findMethod('telemetry.captureCliEvent')
    expect(() =>
      method.params!.parse({
        name: '',
        props: { feature_group: 'discovery', exit_status: 'success' }
      })
    ).toThrow(/Missing event name/)
  })

  it('returns an empty object on success (not raw track() output)', async () => {
    const result = await call('telemetry.captureCliEvent', {
      name: 'cli_feature_used',
      props: { feature_group: 'discovery', exit_status: 'success' }
    })
    expect(result).toEqual({})
  })

  it('returns an empty object on a rejected (non-CLI) event', async () => {
    const result = await call('telemetry.captureCliEvent', {
      name: 'agent_started',
      props: { agent_kind: 'claude-code', launch_source: 'sidebar', request_kind: 'new' }
    })
    expect(result).toEqual({})
  })
})
