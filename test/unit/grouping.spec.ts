/**
 * The browser-side grouping provider's contract: a two-level path, a one-level
 * path, and the unclaimed answer that hands the Session back to core grouping.
 */

import { describe, expect, it } from 'vitest'
import { resolveGroupingPath, workspaceKey } from '../../src/client/grouping.ts'
import type { MapPayload } from '../../src/wire.ts'

/** A map with one placed Session and one group. */
function map(overrides: Partial<MapPayload> = {}): MapPayload {
  return {
    sessions: {
      s1: { workspace: 'k', pinned: false },
      s2: { workspace: 'tinybots', group: 'g1', pinned: true },
    },
    groups: [{
      id: 'g1', name: 'Orders', workspace: 'tinybots', createdAt: '2026-10-01T00:00:00.000Z', order: 3,
    }],
    candidates: ['k', 'tinybots', 'whill'],
    unknownLabel: 'unknown workspace',
    backfill: { running: false, total: 0, pending: 0, done: 0, classified: 0, failed: 0, skipped: 0 },
    ...overrides,
  }
}

describe('resolveGroupingPath', () => {
  it('answers the workspace alone when the Session sits at workspace level', () => {
    expect(resolveGroupingPath(map(), 's1')).toEqual([{ key: 'k', label: 'k' }])
  })

  it('answers workspace then group, with the group\'s own sibling order', () => {
    expect(resolveGroupingPath(map(), 's2')).toEqual([
      { key: 'tinybots', label: 'tinybots' },
      { key: 'g1', label: 'Orders', order: 3 },
    ])
  })

  it('answers undefined for an unclassified Session, leaving core grouping in charge', () => {
    expect(resolveGroupingPath(map(), 'nobody')).toBeUndefined()
    expect(resolveGroupingPath(undefined, 's1')).toBeUndefined()
  })

  it('falls back to the workspace level when the group disappeared between two polls', () => {
    expect(resolveGroupingPath(map({ groups: [] }), 's2')).toEqual([{ key: 'tinybots', label: 'tinybots' }])
  })

  it('keeps the label verbatim and makes the key safe for the seam\'s path join', () => {
    const payload = map({ sessions: { s3: { workspace: 'a:b c', pinned: true } } })
    const path = resolveGroupingPath(payload, 's3')
    expect(path?.[0]?.label).toBe('a:b c')
    expect(path?.[0]?.key).toBe('a-b-c')
    expect(path?.[0]?.key.includes(':')).toBe(false)
  })

  it('keeps the unknown bucket as an ordinary top-level row', () => {
    expect(resolveGroupingPath(map({ sessions: { s4: { workspace: 'unknown workspace', pinned: false } } }), 's4'))
      .toEqual([{ key: 'unknown-workspace', label: 'unknown workspace' }])
  })
})

describe('workspaceKey', () => {
  it('never returns an empty key', () => {
    expect(workspaceKey('   ')).toBe('workspace')
    expect(workspaceKey(':::')).toBe('workspace')
    expect(workspaceKey('k')).toBe('k')
    expect(workspaceKey('dsh-web')).toBe('dsh-web')
  })
})
