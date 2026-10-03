/**
 * The browser-side grouping provider's contract: a two-level path, a one-level
 * path, the unclaimed answer that hands the Session back to core grouping, and
 * the undecided sentinel, which is NOT a row of its own.
 *
 * The sentinel is read from the payload rather than compared to a literal, which
 * is what these cases pin: the same placement is a row under one payload's label
 * and no row at all under another's.
 */

import { describe, expect, it } from 'vitest'
import { newGroupTarget, resolveGroupingPath, workspaceKey } from '../../src/client/grouping.ts'
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
    titleProvider: 'ok',
    ...overrides,
  }
}

/** One placement, as the host records it, without a group. */
function placed(workspace: string): MapPayload {
  return map({ sessions: { s9: { workspace, pinned: false } }, groups: [] })
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

  it('claims NO row for the undecided sentinel, so the Session falls to the core grouping', () => {
    expect(resolveGroupingPath(placed('unknown workspace'), 's9')).toBeUndefined()
  })

  it('reads the sentinel from the payload rather than from a literal', () => {
    // Same label text as the default sentinel, but the payload calls it a decided
    // workspace: it stays an ordinary row. And a payload whose sentinel is some
    // other label stops claiming THAT one instead.
    expect(resolveGroupingPath(map({
      sessions: { s9: { workspace: 'unknown workspace', pinned: false } },
      unknownLabel: 'chua ro',
      groups: [],
    }), 's9')).toEqual([{ key: 'unknown-workspace', label: 'unknown workspace' }])
    expect(resolveGroupingPath(map({
      sessions: { s9: { workspace: 'chua ro', pinned: false } },
      unknownLabel: 'chua ro',
      groups: [],
    }), 's9')).toBeUndefined()
  })

  it('still serves a decided label as its own top-level row', () => {
    expect(resolveGroupingPath(placed('whill'), 's9')).toEqual([{ key: 'whill', label: 'whill' }])
  })

  it('keeps the group row of a sentinel placement, rooted at the group\'s own workspace', () => {
    // A group is a Human placement and carries its own workspace, so letting the
    // sentinel rule win would silently drop the grouping. The root comes from the
    // GROUP record, which is why the two rows do not carry the sentinel label.
    const payload = map({
      sessions: { s9: { workspace: 'unknown workspace', group: 'g2', pinned: true } },
      groups: [{ id: 'g2', name: 'Later', workspace: 'k', createdAt: 'T', order: 1 }],
    })
    expect(resolveGroupingPath(payload, 's9')).toEqual([
      { key: 'k', label: 'k' },
      { key: 'g2', label: 'Later', order: 1 },
    ])
  })

  it('claims nothing when a sentinel placement\'s group is gone', () => {
    const payload = map({
      sessions: { s9: { workspace: 'unknown workspace', group: 'ghost', pinned: true } },
      groups: [],
    })
    expect(resolveGroupingPath(payload, 's9')).toBeUndefined()
  })
})

describe('newGroupTarget', () => {
  it('inherits the Session\'s own placement when that placement is a real workspace', () => {
    expect(newGroupTarget(map(), 's1')).toBe('k')
    expect(newGroupTarget(map(), 's2')).toBe('tinybots')
  })

  it('requires an explicit candidate on the undecided sentinel, so no group is created there', () => {
    expect(newGroupTarget(placed('unknown workspace'), 's9')).toBeUndefined()
    // The payload's own sentinel is the one that counts, never a literal.
    expect(newGroupTarget(map({
      sessions: { s9: { workspace: 'chua ro', pinned: false } },
      unknownLabel: 'chua ro',
      groups: [],
    }), 's9')).toBeUndefined()
  })

  it('asks for a choice when the Session carries no placement at all', () => {
    expect(newGroupTarget(map(), 'nobody')).toBeUndefined()
    expect(newGroupTarget(undefined, 's1')).toBeUndefined()
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
