/**
 * The durable store's contract: the record layout, the put-then-update rule, the
 * pin, group CRUD, lazy dangling-group resolution, one handle per unit, and the
 * release on dispose.
 */

import { describe, expect, it } from 'vitest'
import { UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import { sessionWorkspacesDomain } from '../../src/host/domain.ts'
import { openStore, WorkspaceStore } from '../../src/host/store.ts'
import { DOMAIN_NAME, DOMAIN_VERSION } from '../../src/config.ts'
import { FakeDomain, FakeFacility } from '../support/fake-domain.ts'

/** A store over the in-memory double, with deterministic ids and time. */
function makeStore(): { readonly store: WorkspaceStore; readonly domain: FakeDomain } {
  const domain = new FakeDomain()
  let id = 0
  const store = new WorkspaceStore(domain, {
    now: () => '2026-10-01T00:00:00.000Z',
    newId: () => `group-${++id}`,
  })
  return { store, domain }
}

describe('domain declaration', () => {
  it('names the unit inside the storage name grammar and pins version 1', () => {
    expect(sessionWorkspacesDomain.name).toBe(DOMAIN_NAME)
    expect(UNIT_NAME_RE.test(sessionWorkspacesDomain.name)).toBe(true)
    expect(sessionWorkspacesDomain.version).toBe(DOMAIN_VERSION)
    expect(Object.keys(sessionWorkspacesDomain.tables)).toEqual(['labels', 'groups', 'pins'])
  })
})

describe('records', () => {
  it('writes a label as put on a fresh Session and update afterwards', async () => {
    const { store, domain } = makeStore()
    expect(await store.recordLabel('s1', 'k', 0.9)).toBe(true)
    expect(domain.labels.writes).toEqual(['put:s1'])
    expect(await store.recordLabel('s1', 'whill', 0.8)).toBe(true)
    expect(domain.labels.writes).toEqual(['put:s1', 'update:s1'])
    expect(store.labelOf('s1')).toEqual({ workspace: 'whill', confidence: 0.8, decidedAt: '2026-10-01T00:00:00.000Z' })
  })

  it('places an unclassified Session nowhere, so the core grouping keeps it', () => {
    const { store } = makeStore()
    expect(store.placementOf('nobody')).toBeUndefined()
    expect(store.placements().size).toBe(0)
  })

  it('writes an assignment as put then update, and pins it', async () => {
    const { store, domain } = makeStore()
    expect(await store.assign({ sessionId: 's1', workspace: 'k' })).toEqual({ workspace: 'k', pinned: true })
    expect(domain.pins.writes).toEqual(['put:s1'])
    expect(await store.assign({ sessionId: 's1', workspace: 'whill' })).toEqual({ workspace: 'whill', pinned: true })
    expect(domain.pins.writes).toEqual(['put:s1', 'update:s1'])
    expect(store.isPinned('s1')).toBe(true)
  })

  it('never reclassifies a pinned Session', async () => {
    const { store, domain } = makeStore()
    await store.assign({ sessionId: 's1', workspace: 'k' })
    expect(await store.recordLabel('s1', 'tinybots', 0.99)).toBe(false)
    expect(domain.labels.records.size).toBe(0)
    expect(store.placementOf('s1')).toEqual({ workspace: 'k', pinned: true })
  })

  it('keeps a pin over a label that already exists', async () => {
    const { store } = makeStore()
    await store.recordLabel('s1', 'k', 0.9)
    await store.assign({ sessionId: 's1', workspace: 'whill' })
    expect(store.placementOf('s1')).toEqual({ workspace: 'whill', pinned: true })
  })
})

describe('groups', () => {
  it('creates groups in order and carries the owning workspace on the record', async () => {
    const { store } = makeStore()
    const first = await store.createGroup({ workspace: 'k', name: 'Release' })
    const second = await store.createGroup({ workspace: 'k', name: 'Docs' })
    expect(first).toMatchObject({ id: 'group-1', name: 'Release', workspace: 'k', order: 0 })
    expect(second.order).toBe(1)
    expect(store.groupsInOrder().map(group => group.name)).toEqual(['Release', 'Docs'])
  })

  it('moves a Session into a group owned by another workspace, and moves the workspace too', async () => {
    const { store } = makeStore()
    const group = await store.createGroup({ workspace: 'tinybots', name: 'Orders' })
    expect(await store.assign({ sessionId: 's1', workspace: 'k', group: group.id }))
      .toEqual({ workspace: 'tinybots', group: group.id, pinned: true })
    expect(store.placementOf('s1')).toEqual({ workspace: 'tinybots', group: group.id, pinned: true })
  })

  it('refuses to assign into a group that does not exist', async () => {
    const { store } = makeStore()
    expect(await store.assign({ sessionId: 's1', workspace: 'k', group: 'ghost' })).toBeUndefined()
    expect(store.pinOf('s1')).toBeUndefined()
  })

  it('relabels a group without touching its members', async () => {
    const { store } = makeStore()
    const group = await store.createGroup({ workspace: 'k', name: 'Release' })
    await store.assign({ sessionId: 's1', workspace: 'k', group: group.id })
    expect(await store.renameGroup(group.id, 'Shipped')).toMatchObject({ id: group.id, name: 'Shipped' })
    expect(store.placementOf('s1')).toEqual({ workspace: 'k', group: group.id, pinned: true })
    expect(await store.renameGroup('ghost', 'x')).toBeUndefined()
  })

  it('deletes a group in one write and returns its members to the workspace level at read time', async () => {
    const { store, domain } = makeStore()
    const group = await store.createGroup({ workspace: 'k', name: 'Release' })
    await store.assign({ sessionId: 's1', workspace: 'k', group: group.id })
    await store.assign({ sessionId: 's2', workspace: 'k', group: group.id })
    const before = domain.pins.writes.length
    expect(await store.deleteGroup(group.id)).toBe(true)
    // One atomic delete, and no member record is rewritten.
    expect(domain.groups.writes.filter(write => write.startsWith('delete:'))).toEqual([`delete:${group.id}`])
    expect(domain.pins.writes.length).toBe(before)
    expect(store.placementOf('s1')).toEqual({ workspace: 'k', pinned: true })
    expect(store.placementOf('s2')).toEqual({ workspace: 'k', pinned: true })
    expect(await store.deleteGroup(group.id)).toBe(false)
  })

  it('returns a Session to the workspace level on request, still pinned', async () => {
    const { store } = makeStore()
    const group = await store.createGroup({ workspace: 'k', name: 'Release' })
    await store.assign({ sessionId: 's1', workspace: 'k', group: group.id })
    await store.removeMember('s1', 'k')
    expect(store.placementOf('s1')).toEqual({ workspace: 'k', pinned: true })
  })
})

describe('the map a read publishes', () => {
  it('publishes placements, groups, the candidate set and backfill progress', async () => {
    const { store } = makeStore()
    const group = await store.createGroup({ workspace: 'k', name: 'Release' })
    await store.recordLabel('s1', 'k', 0.9)
    await store.assign({ sessionId: 's2', workspace: 'k', group: group.id })
    const map = store.snapshot({
      candidates: ['k', 'tinybots'],
      unknownLabel: 'unknown workspace',
      backfill: { running: false, total: 0, pending: 3, done: 0, classified: 0, failed: 0, skipped: 0 },
      titleProvider: 'unavailable',
    })
    expect(Object.keys(map.sessions).sort()).toEqual(['s1', 's2'])
    expect(map.sessions['s1']).toEqual({ workspace: 'k', pinned: false })
    expect(map.sessions['s2']).toEqual({ workspace: 'k', group: group.id, pinned: true })
    expect(map.groups).toHaveLength(1)
    expect(map.candidates).toEqual(['k', 'tinybots'])
    expect(map.backfill.pending).toBe(3)
    // The title status is published verbatim, so a misconfigured profile is
    // observable without a log line.
    expect(map.titleProvider).toBe('unavailable')
  })
})

describe('handle lifetime', () => {
  it('refuses a second open of the same unit while the first is live, and allows one after close', async () => {
    const facility = new FakeFacility()
    const store = await openStore(facility)
    const first = facility.domain
    await expect(openStore(facility)).rejects.toMatchObject({ code: 'already-open' })
    expect(facility.opened).toEqual([DOMAIN_NAME])
    await store.close()
    expect(first?.closes).toBe(1)
    const reopened = await openStore(facility)
    expect(facility.opened).toEqual([DOMAIN_NAME, DOMAIN_NAME])
    await reopened.close()
    expect(facility.domain).toBeUndefined()
  })

  it('closes the handle exactly once on dispose', async () => {
    const facility = new FakeFacility()
    const store = await openStore(facility)
    await store.close()
    expect(facility.domain).toBeUndefined()
  })

  it('repairs a record that vanished between the read and the write', async () => {
    const { store, domain } = makeStore()
    await store.recordLabel('s1', 'k', 0.9)
    // The next write reads a present record and updates it; simulate the race by
    // deleting between the read and the update.
    const originalUpdate = domain.labels.update.bind(domain.labels)
    domain.labels.update = async (key, fn) => {
      domain.labels.records.delete(key)
      return await originalUpdate(key, fn)
    }
    expect(await store.recordLabel('s1', 'whill', 0.8)).toBe(true)
    expect(store.labelOf('s1')?.workspace).toBe('whill')
  })
})
