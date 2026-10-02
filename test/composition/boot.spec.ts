/**
 * The assembled plugin: the built artifact, mounted by the real Loader through a
 * generated `cordis.yml`, driven over its real event and route surfaces.
 *
 * This is where the plan's three load-bearing claims are checked end to end
 * rather than in isolation: the classification call carries no `sessionId` and
 * appends nothing to the conversation surface, the route is resolved from Config
 * then the Session's own logged route and otherwise no call happens at all, and a
 * pinned Session is never re-decided.
 *
 * Every turn here is delivered in the host's own order — the prompt, then the
 * `request/header` that carries the route — because the plugin acts on the
 * header. `test/composition/route-ordering.spec.ts` drives the same ordering
 * through a REAL `Session` and a real projection registry; this file drives it
 * through the stubs, so the two disagreeing is itself a signal.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { boot, requestHeader, type Composition } from './harness.ts'
import { CATALOG_PATH, MAP_PATH } from '../../src/config.ts'

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

/** The one route pair every stub turn runs on unless a test says otherwise. */
const ROUTE = { provider: 'p', model: 'm' } as const

describe('composition', () => {
  it('activates the built artifact and registers its four fenced routes', async () => {
    const composition = await bootTracked()
    expect(composition.routes.map(route => route.path)).toContain(MAP_PATH)
    expect(composition.routes.map(route => route.path)).toContain(CATALOG_PATH)
    expect(composition.routes).toHaveLength(4)
    await composition.ready()
  })

  it('answers the advertised route catalog over its own fenced route', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const route = composition.routes.find(candidate => candidate.path === CATALOG_PATH)
    const response = await route?.fetch(new Request(`http://127.0.0.1${CATALOG_PATH}`, { method: 'GET' }))
    const payload = await response?.json() as { data: { routes: unknown[]; failed: unknown[]; sampledAt: string } }
    expect(payload.data.routes).toEqual([{ provider: 'fixture-p', model: 'fixture-m' }])
    expect(payload.data.failed).toEqual([])
    expect(typeof payload.data.sampledAt).toBe('string')
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
    composition.turn(session, 'please fix the tinybots order sync', { provider: 'session-p', model: 'session-m' })
    await composition.settle()

    expect(composition.llmCalls).toHaveLength(1)
    expect(composition.llmCalls[0]?.provider).toBe('session-p')
    expect(labelOf(composition, 's1')).toBe('k')
  })

  it('makes no call while only the prompt is committed, then classifies when its header arrives', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    // The prompt alone: this is the instant at which a brand-new Session has NO
    // logged route, so nothing may be called and nothing may be recorded.
    composition.fire(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'work on the k repo' }] }, seq: 8 })
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(0)
    expect(labelOf(composition, 's1')).toBeUndefined()

    // The header the same turn appends, carrying the route.
    session.route = ROUTE
    composition.fire(session, requestHeader(ROUTE.provider, ROUTE.model))
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(1)
    expect(labelOf(composition, 's1')).toBe('k')
  })

  it('makes no call at all when neither Config nor the Session resolves a route', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    composition.turn(session, 'no route anywhere')
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(0)
    expect(labelOf(composition, 's1')).toBeUndefined()
  })

  it('prefers the configured route', async () => {
    const composition = await bootTracked({ provider: 'cfg-p', model: 'cfg-m' })
    await composition.ready()
    const session = composition.session('s1')
    composition.turn(session, 'anything', { provider: 'session-p', model: 'session-m' })
    await composition.settle()
    expect(composition.llmCalls[0]?.provider).toBe('cfg-p')
  })

  it('sends no sessionId, no purpose, and appends nothing to the conversation surface', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    composition.turn(session, 'work on the k repo', ROUTE)
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
    composition.projection({ count: 2, seq: 9, prompt: 'a first prompt' })
    const session = composition.session('s1')
    composition.turn(session, 'a second prompt', ROUTE)
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(0)
  })

  it('ignores a non-human message and a child Session', async () => {
    const composition = await bootTracked()
    await composition.ready()
    composition.projection({ count: 1, seq: 1, prompt: null })
    const session = composition.session('s1')
    composition.fire(session, { type: 'user/message', data: { source: { kind: 'agent' }, content: [{ type: 'text', text: 'tool output' }] } })
    composition.fire(session, requestHeader(ROUTE.provider, ROUTE.model))
    composition.projection({ count: 1, seq: 1, prompt: 'from a subagent' })
    const child = composition.session('child', { parent: 's1' })
    composition.turn(child, 'from a subagent', ROUTE)
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(0)
  })

  it('records nothing when the provider fails, and leaves the Session alone', async () => {
    const composition = await bootTracked()
    await composition.ready()
    composition.scriptThrow('socket closed')
    const session = composition.session('s1')
    composition.turn(session, 'work on the k repo', ROUTE)
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(1)
    expect(labelOf(composition, 's1')).toBeUndefined()
    expect(session.appended).toEqual([])
  })

  it('attempts a failing Session once, not once per header', async () => {
    const composition = await bootTracked()
    await composition.ready()
    composition.scriptThrow('socket closed')
    const session = composition.session('s1')
    composition.turn(session, 'work on the k repo', ROUTE)
    await composition.settle()
    // A later turn commits more headers (change / series) for the same Session.
    composition.fire(session, requestHeader(ROUTE.provider, ROUTE.model))
    composition.fire(session, requestHeader(ROUTE.provider, ROUTE.model))
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(1)
  })

  it('records nothing for an unparseable answer', async () => {
    const composition = await bootTracked()
    await composition.ready()
    composition.script([
      { type: 'text-delta', index: 0, text: 'I believe it is k' },
      { type: 'finish', reason: { kind: 'stop' } },
    ] as readonly StreamChunk[])
    const session = composition.session('s1')
    composition.turn(session, 'work on the k repo', ROUTE)
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
    composition.turn(session, 'work on the shopify repo', ROUTE)
    await composition.settle()
    expect(labelOf(composition, 's1')).toBe('unknown workspace')
  })

  it('never re-decides a pinned Session', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    // A Human assignment lands first, as the menu action does it.
    const route = composition.routes.find(candidate => candidate.path === MAP_PATH)
    expect(route).toBeDefined()
    const store = composition.facility.domain
    await store?.pins.put('s1', { workspace: 'tinybots', pinnedAt: '2026-10-01T00:00:00.000Z' })
    composition.turn(session, 'work on the k repo', ROUTE)
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(0)
    expect(labelOf(composition, 's1')).toBeUndefined()
  })

  it('publishes the recorded label on the fenced map route', async () => {
    const composition = await bootTracked()
    await composition.ready()
    const session = composition.session('s1')
    composition.turn(session, 'work on the k repo', ROUTE)
    await composition.settle()
    const route = composition.routes.find(candidate => candidate.path === MAP_PATH)
    const response = await route?.fetch(new Request(`http://127.0.0.1${MAP_PATH}`, { method: 'GET' }))
    const payload = await response?.json() as { data: { sessions: Record<string, { workspace: string; pinned: boolean }> } }
    expect(payload.data.sessions['s1']).toEqual({ workspace: 'k', pinned: false })
  })
})

describe('the title half', () => {
  it('registers ONE provider on the host title service, on the first prompt', async () => {
    const composition = await bootTracked({ sessionTitle: 'open' })
    await composition.ready()
    expect(composition.titleProvider?.id).toBe('dsh-session-workspaces')
    expect(composition.titleProvider?.automatic).toBe('first-prompt')
    expect(composition.warnings).toEqual([])
  })

  it('serves the title from the ONE model call the classification already makes', async () => {
    const composition = await bootTracked({ sessionTitle: 'open' })
    await composition.ready()
    const session = composition.session('s1')
    // Hold the call open, so both halves ask while it is still in flight.
    composition.hold()
    composition.turn(session, 'work on the k repo', ROUTE)
    const pending = composition.title(session, [{ seq: 1, text: 'work on the k repo' }])
    expect(composition.llmCalls).toHaveLength(1)
    composition.release()

    const result = await pending
    expect(result.title).toBe('work on the k repo')
    expect(result.messageSeqs).toEqual([1])
    expect(result.model).toEqual(ROUTE)
    await composition.settle()
    // One Session, one call, both outcomes.
    expect(composition.llmCalls).toHaveLength(1)
    expect(labelOf(composition, 's1')).toBe('k')
  })

  it('answers with the FIRST seq of the snapshot the service handed it, and only that one', async () => {
    const composition = await bootTracked({ sessionTitle: 'open' })
    await composition.ready()
    const session = composition.session('s1')
    // Hold the call open, so the title request shares the in-flight decision
    // instead of being refused for arriving after it.
    composition.hold()
    composition.turn(session, 'work on the k repo', ROUTE)
    // A two-message snapshot: the provider must name the first of them and nothing
    // else. This is the only place the plugin's answer can be separated from its
    // own prompt projection, because the service is what chooses the snapshot.
    const pending = composition.title(session, [
      { seq: 4, text: 'please fix the tinybots order sync' },
      { seq: 9, text: 'and the report too' },
    ])
    composition.release()
    const result = await pending
    expect(result.messageSeqs).toEqual([4])
    await composition.settle()
  })

  it('refuses a title request for a Session it has already decided', async () => {
    const composition = await bootTracked({ sessionTitle: 'open' })
    await composition.ready()
    const session = composition.session('s1')
    composition.turn(session, 'work on the k repo', ROUTE)
    await composition.settle()
    // No second decision exists to share, so the request is refused rather than
    // answered from the first one.
    await expect(composition.title(session, [{ seq: 7, text: 'x' }]))
      .rejects.toThrow(/already-decided/u)
  })

  it('leaves a Session with no summary to the core fallback instead of an empty title', async () => {
    const composition = await bootTracked({ sessionTitle: 'open' })
    await composition.ready()
    composition.script([
      { type: 'text-delta', index: 0, text: '{"label":"k","confidence":0.9}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ] as readonly StreamChunk[])
    const session = composition.session('s1')
    composition.hold()
    composition.turn(session, 'work on the k repo', ROUTE)
    const pending = composition.title(session, [{ seq: 1, text: 'work on the k repo' }])
    composition.release()
    await expect(pending).rejects.toThrow(/without a summary/u)
    await composition.settle()
    // The label decision is untouched by the missing summary.
    expect(labelOf(composition, 's1')).toBe('k')
  })

  it('warns loudly and keeps booting when the shipped title row is still registered', async () => {
    const composition = await bootTracked({ sessionTitle: 'taken' })
    await composition.ready()
    expect(composition.titleProvider).toBeUndefined()
    expect(composition.warnings).toHaveLength(1)
    expect(composition.warnings[0]).toContain('already registered')
    // The warning names the missing profile edit, because that is the fix.
    expect(composition.warnings[0]).toContain('session-title-llm')
    expect(composition.warnings[0]).toContain('disabled: true')
    // The host booted: the grouping half still works end to end.
    expect(composition.routes).toHaveLength(4)
    const session = composition.session('s1')
    composition.turn(session, 'work on the k repo', ROUTE)
    await composition.settle()
    expect(labelOf(composition, 's1')).toBe('k')
  })

  it('mounts the grouping half on a host with no title service at all', async () => {
    const composition = await bootTracked()
    await composition.ready()
    expect(composition.titleProvider).toBeUndefined()
    expect(composition.warnings).toEqual([])
    const session = composition.session('s1')
    composition.turn(session, 'work on the k repo', ROUTE)
    await composition.settle()
    expect(composition.llmCalls).toHaveLength(1)
    expect(labelOf(composition, 's1')).toBe('k')
  })

  it('reports the precondition ONLY for the duplicate, and every other refusal as itself', async () => {
    // The singleton refusal: the profile edit is the fix, so it is named.
    const duplicate = await bootTracked({ sessionTitle: 'taken' })
    await duplicate.ready()
    expect(duplicate.warnings).toHaveLength(1)
    expect(duplicate.warnings[0]).toContain('HARD PRECONDITION')
    expect(duplicate.warnings[0]).toContain('session-title-llm')

    // A service that refuses for any other reason — a validation error here — is
    // NOT the profile's fault, so the precondition must not be named.
    const other = await bootTracked({
      sessionTitle: 'open',
      sessionTitleRefusal: 'session-title provider automatic mode is invalid',
    })
    await other.ready()
    expect(other.warnings).toHaveLength(1)
    expect(other.warnings[0]).toContain('automatic mode is invalid')
    expect(other.warnings[0]).not.toContain('HARD PRECONDITION')
    expect(other.warnings[0]).not.toContain('session-title-llm')
  })

  it('publishes whether it owns the Conversation title on the fenced map route', async () => {
    const read = async (composition: Composition): Promise<unknown> => {
      const route = composition.routes.find(candidate => candidate.path === MAP_PATH)
      const response = await route?.fetch(new Request(`http://127.0.0.1${MAP_PATH}`, { method: 'GET' }))
      const payload = await response?.json() as { data: { titleProvider: unknown } }
      return payload.data.titleProvider
    }
    // The plugin holds the title...
    const owned = await bootTracked({ sessionTitle: 'open' })
    await owned.ready()
    expect(owned.warnings).toEqual([])
    expect(await read(owned)).toBe('ok')

    // ...and does not, because the shipped row got there first. This is the same
    // state the guard warns about, made observable without a log — a successful
    // boot has no visible log sink, so a `warn` reaches nobody.
    const taken = await bootTracked({ sessionTitle: 'taken' })
    await taken.ready()
    expect(await read(taken)).toBe('unavailable')
  })
})
