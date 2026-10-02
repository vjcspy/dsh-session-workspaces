/**
 * The Session-menu actions, driven exactly as the menu entries drive them: the
 * same request bodies through the same fenced route into the same store.
 *
 * What this proves is the ACTION layer — that an assignment lands, that creating
 * a group and moving into it lands, that deleting a group returns its members to
 * the workspace level, and that a correction sticks. The click itself is proven
 * in the browser, where the slot renders.
 */

import { describe, expect, it } from 'vitest'
import { MUTATE_PATH } from '../../src/config.ts'
import { Backfill } from '../../src/host/backfill.ts'
import { mutateRoute, routeDeps } from '../../src/host/routes.ts'
import { WorkspaceStore } from '../../src/host/store.ts'
import type { MapPayload, MutateRequest } from '../../src/wire.ts'
import { FakeDomain } from '../support/fake-domain.ts'

/** A route over a store, plus the store itself. */
function harness(): {
  readonly store: WorkspaceStore
  readonly send: (body: MutateRequest) => Promise<MapPayload>
} {
  let next = 0
  const store = new WorkspaceStore(new FakeDomain(), {
    now: () => '2026-10-01T00:00:00.000Z',
    newId: () => `group-${++next}`,
  })
  const backfill = new Backfill({
    store,
    listSessions: async () => [],
    readSession: async () => ({ events: [] }),
    stream: () => (async function* () { /* unused */ })(),
    settings: () => ({ provider: '', model: '', candidates: [], unknownLabel: 'unknown workspace', threshold: 0.5 }),
    log: () => {},
  })
  const deps = routeDeps({
    store,
    backfill,
    candidates: () => ['k', 'tinybots'],
    unknownLabel: () => 'unknown workspace',
    titleProvider: () => 'ok',
  })
  const route = mutateRoute(deps)
  const send = async (body: MutateRequest): Promise<MapPayload> => {
    const response = await route.fetch(new Request(`http://127.0.0.1${MUTATE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    expect(response.status).toBe(200)
    const payload = await response.json() as { data: { map: MapPayload } }
    return payload.data.map
  }
  return { store, send }
}

describe('the menu actions', () => {
  it('lands a "move to workspace" and pins the Session', async () => {
    const { store, send } = harness()
    const map = await send({ sessionId: 's1', workspace: 'tinybots' })
    expect(map.sessions['s1']).toEqual({ workspace: 'tinybots', pinned: true })
    expect(store.isPinned('s1')).toBe(true)
  })

  it('creates a group and moves a Session into it, then returns it to the workspace level on delete', async () => {
    const { send } = harness()
    const created = await send({ op: 'group.create', workspace: 'k', name: 'Release' })
    const group = created.groups[0]
    expect(group).toBeDefined()
    const id = group?.id ?? ''

    const moved = await send({ sessionId: 's1', workspace: 'k', group: id })
    expect(moved.sessions['s1']).toEqual({ workspace: 'k', group: id, pinned: true })

    const deleted = await send({ op: 'group.delete', group: id })
    expect(deleted.groups).toEqual([])
    // One atomic delete, and the member is back at workspace level.
    expect(deleted.sessions['s1']).toEqual({ workspace: 'k', pinned: true })
  })

  it('moves the Session\'s workspace with the group when the group belongs to another workspace', async () => {
    const { send } = harness()
    const created = await send({ op: 'group.create', workspace: 'tinybots', name: 'Orders' })
    const id = created.groups[0]?.id ?? ''
    const moved = await send({ sessionId: 's1', workspace: 'k', group: id })
    expect(moved.sessions['s1']).toEqual({ workspace: 'tinybots', group: id, pinned: true })
  })

  it('relabels a group without moving its members', async () => {
    const { send } = harness()
    const created = await send({ op: 'group.create', workspace: 'k', name: 'Release' })
    const id = created.groups[0]?.id ?? ''
    await send({ sessionId: 's1', workspace: 'k', group: id })
    const renamed = await send({ op: 'group.rename', group: id, name: 'Shipped' })
    expect(renamed.groups[0]?.name).toBe('Shipped')
    expect(renamed.sessions['s1']).toEqual({ workspace: 'k', group: id, pinned: true })
  })

  it('takes a Session out of its group but keeps it pinned', async () => {
    const { store, send } = harness()
    const created = await send({ op: 'group.create', workspace: 'k', name: 'Release' })
    const id = created.groups[0]?.id ?? ''
    await send({ sessionId: 's1', workspace: 'k', group: id })
    const removed = await send({ op: 'group.removeMember', sessionId: 's1', workspace: 'k' })
    expect(removed.sessions['s1']).toEqual({ workspace: 'k', pinned: true })
    // The override stands: nothing re-decides a corrected Session.
    expect(await store.recordLabel('s1', 'whill', 0.99)).toBe(false)
    expect(store.placementOf('s1')).toEqual({ workspace: 'k', pinned: true })
  })

  it('corrects a misclassification from the same menu and keeps the correction', async () => {
    const { store, send } = harness()
    await store.recordLabel('s1', 'whill', 0.8)
    expect(store.placementOf('s1')).toEqual({ workspace: 'whill', pinned: false })
    const corrected = await send({ sessionId: 's1', workspace: 'tinybots' })
    expect(corrected.sessions['s1']).toEqual({ workspace: 'tinybots', pinned: true })
    expect(await store.recordLabel('s1', 'whill', 0.99)).toBe(false)
    expect(store.placementOf('s1')).toEqual({ workspace: 'tinybots', pinned: true })
  })
})
