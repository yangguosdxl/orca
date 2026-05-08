import { describe, expect, it } from 'vitest'
import { isStablePaneId, parsePaneKey } from './stable-pane-id'

describe('isStablePaneId', () => {
  it('accepts a v4 UUID', () => {
    expect(isStablePaneId('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isStablePaneId('aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee')).toBe(true)
  })

  it('rejects pre-migration numeric pane suffixes', () => {
    expect(isStablePaneId('1')).toBe(false)
    expect(isStablePaneId('42')).toBe(false)
    expect(isStablePaneId('00000000')).toBe(false)
  })

  it('rejects malformed strings', () => {
    expect(isStablePaneId('')).toBe(false)
    expect(isStablePaneId('not-a-uuid')).toBe(false)
    // v4 UUIDs require version 4 in the third group.
    expect(isStablePaneId('11111111-1111-3111-8111-111111111111')).toBe(false)
  })
})

describe('parsePaneKey', () => {
  it('returns tab id and stable pane id for a UUID-suffix paneKey', () => {
    expect(parsePaneKey('tab-1:11111111-1111-4111-8111-111111111111')).toEqual({
      tabId: 'tab-1',
      stablePaneId: '11111111-1111-4111-8111-111111111111'
    })
  })

  it('rejects pre-migration paneKeys with numeric suffix', () => {
    expect(parsePaneKey('tab-1:5')).toBeNull()
    expect(parsePaneKey('tab-1:')).toBeNull()
  })

  it('rejects paneKeys without a colon', () => {
    expect(parsePaneKey('tab-1')).toBeNull()
  })

  it('handles tabIds containing dashes', () => {
    expect(parsePaneKey('tab-12345:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toEqual({
      tabId: 'tab-12345',
      stablePaneId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
  })

  it('rejects a paneKey whose suffix contains an extra colon segment', () => {
    // Why: split-on-first-colon would produce a non-UUID stable id, which
    // the regex check rejects. Tabs whose IDs themselves contain colons
    // would break this contract — store invariants prevent that today.
    expect(parsePaneKey('a:b:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeNull()
  })
})
