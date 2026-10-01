/**
 * The assembled plugin: the built artifact, mounted by the real Loader through a
 * generated `cordis.yml`, driven over its real event and route surfaces.
 *
 * This is where the plan's three load-bearing claims are checked end to end
 * rather than in isolation: the classification call carries no `sessionId` and
 * appends nothing to the conversation surface, the route is resolved from Config
 * then the Session's own logged route and otherwise no call happens at all, and a
 * pinned Session is never re-decided.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { boot, humanMessage, requestHeader, type Composition } from './harness.ts'
import { MAP_PATH } from '../../src/config.ts'

/** Compositions booted by the current spec, torn down afterwards. */
const live: Composition[] = []

/** Boot, remembering the composition for teardown. */
async function bootTracked(options: Parameters<typeof boot>[0] = {}): Promise<Composition> {
  const composition = await boot(options)
  live.push(composition)
  return composition
}

afterEach(async () => {
  while (live.length > 0) await live.pop()?.dispose()
})

/** The label the plugin recorded for a Session, if any. */
function labelOf(composition: Composition, sessionId: string): string | undefined {
  return composition.facility.domain?.labels.get(sessionId)?.workspace
}

describe('composition', () => {
  it('activates the built artifact and registers its three fenced routes', async () => {
    const composition = await bootTracked()
    expect(composition.routes.map(route => route.path)).toContain(MAP_PATH)
    expect(composition.routes).toHaveLength(3)
    await composition.ready()
  })

  it('mounts nothing when the profile omits the row', async () => {
    const composition = await bootTracked({ withPlugin: false })
    expect(composition.routes).toHaveLength(0)
  })
})

describe('the classification cadence', () => {
  it('classifies the first human prompt through the Session\'s own logged route', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    session.route = { provider: 'session-p', model: 'session-m' }
    composition.fire(session, humanMessage('please fix the tinybots order sync'))
    await composition.settle()

    expect(composition.llmCalls).toHaveLength(1)
    expect(labelOf(composition, 's1')).toBe('k')
  })

  it('waits for the request header when the Session has no route yet, then classifies', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    composition.fire(session, humanMessage('work on the k repo'))
    await composition.settle()
    // No route yet: nothing was called and nothing was recorded.
    expect(composition.llmCalls).toHaveLength(0)

    session.route = { provider: 'p', model: 'm' }
    composition.fire(session, requestHeader('p', 'm'))
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(1)
    expect(labelOf(composition, 's1')).toBe('k')
  })

  it('makes no call at all when neither Config nor the Session resolves a route', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    composition.fire(session, humanMessage('no route anywhere'))
    composition.fire(session, requestHeader('', ''))
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(0)
    expect(labelOf(composition, 's1')).toBeUndefined()
  })

  it('prefers the configured route', async () => {
    const composition = await bootTracked({ provider: 'cfg-p', model: 'cfg-m' })
    await composition.ready()
    const session = composition.session('s1')
    session.route = { provider: 'session-p', model: 'session-m' }
    composition.fire(session, humanMessage('anything'))
    await composition.settle()
    expect(composition.llmCalls[0]?.provider).toBe('cfg-p')
  })

  it('sends no sessionId, no purpose, and appends nothing to the conversation surface', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    session.route = { provider: 'p', model: 'm' }
    composition.fire(session, humanMessage('work on the k repo'))
    await composition.settle()

    const call = composition.llmCalls[0]
    expect(call).toBeDefined()
    expect('sessionId' in (call as object)).toBe(false)
    expect('purpose' in (call as object)).toBe(false)
    expect(session.appended).toEqual([])
  })

  it('ignores a Session that is not on its first human message', async () => {
    const composition = await bootTracked()
    await composition.ready()
    composition.projection({ count: 2, seq: 9 })
    const session = composition.session('s1')
    session.route = { provider: 'p', model: 'm' }
    composition.fire(session, humanMessage('a second prompt'))
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(0)
  })

  it('ignores a non-human message and a child Session', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    session.route = { provider: 'p', model: 'm' }
    composition.fire(session, { type: 'user/message', data: { source: { kind: 'agent' }, content: [{ type: 'text', text: 'tool output' }] } })
    const child = composition.session('child', { parent: 's1' })
    child.route = { provider: 'p', model: 'm' }
    composition.fire(child, humanMessage('from a subagent'))
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(0)
  })

  it('records nothing when the provider fails, and leaves the Session alone', async () => {
    const composition = await bootTracked()
    await composition.ready()
    composition.scriptThrow('socket closed')
    const session = composition.session('s1')
    session.route = { provider: 'p', model: 'm' }
    composition.fire(session, humanMessage('work on the k repo'))
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(1)
    expect(labelOf(composition, 's1')).toBeUndefined()
    expect(session.appended).toEqual([])
  })

  it('records nothing for an unparseable answer', async () => {
    const composition = await bootTracked()
    await composition.ready()
    composition.script([
      { type: 'text-delta', index: 0, text: 'I believe it is k' },
      { type: 'finish', reason: { kind: 'stop' } },
    ] as readonly StreamChunk[])
    const session = composition.session('s1')
    session.route = { provider: 'p', model: 'm' }
    composition.fire(session, humanMessage('work on the k repo'))
    await composition.settle()
    expect(labelOf(composition, 's1')).toBeUndefined()
  })

  it('records the unknown label for an out-of-set answer', async () => {
    const composition = await bootTracked()
    await composition.ready()
    composition.script([
      { type: 'text-delta', index: 0, text: '{"label":"shopify","confidence":0.99}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ] as readonly StreamChunk[])
    const session = composition.session('s1')
    session.route = { provider: 'p', model: 'm' }
    composition.fire(session, humanMessage('work on the shopify repo'))
    await composition.settle()
    expect(labelOf(composition, 's1')).toBe('unknown workspace')
  })

  it('never re-decides a pinned Session', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    session.route = { provider: 'p', model: 'm' }
    // A Human assignment lands first, as the menu action does it.
    const route = composition.routes.find(candidate => candidate.path === MAP_PATH)
    expect(route).toBeDefined()
    const store = composition.facility.domain
    await store?.pins.put('s1', { workspace: 'tinybots', pinnedAt: '2026-10-01T00:00:00.000Z' })
    composition.fire(session, humanMessage('work on the k repo'))
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(0)
    expect(labelOf(composition, 's1')).toBeUndefined()
  })

  it('publishes the recorded label on the fenced map route', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    session.route = { provider: 'p', model: 'm' }
    composition.fire(session, humanMessage('work on the k repo'))
    await composition.settle()
    const route = composition.routes.find(candidate => candidate.path === MAP_PATH)
    const response = await route?.fetch(new Request(`http://127.0.0.1${MAP_PATH}`, { method: 'GET' }))
    const payload = await response?.json() as { data: { sessions: Record<string, { workspace: string; pinned: boolean }> } }
    expect(payload.data.sessions['s1']).toEqual({ workspace: 'k', pinned: false })
  })
})
