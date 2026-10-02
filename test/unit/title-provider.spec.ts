/**
 * The title provider's own contract, driven against a real `DecisionLedger`.
 *
 * The provider is the bridge between the one classification answer and the core
 * title service, so what is asserted here is exactly what the service's
 * `validateResult` enforces: a non-empty title, seqs taken from the request
 * snapshot, and a route. Everything else — no summary, a skipped decision, a
 * cancelled request — must throw, because a throw is what hands the Session to
 * the core fallback title instead of writing an empty one.
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { DecisionLedger, type DecisionSettings } from '../../src/host/decision.ts'
import { createTitleProvider, TITLE_PROVIDER_ID } from '../../src/host/title-provider.ts'
import type { WorkspaceStore } from '../../src/host/store.ts'

/** A Session carrier: only the facts the ledger reads are present. */
function sessionFixture(id = 's1', parent?: unknown): Session {
  return {
    id,
    header: parent === undefined ? {} : { parentSession: parent },
  } as unknown as Session
}

/** A store stub: decided-ness and the durable label write, both scriptable. */
function storeFixture(decided = false): WorkspaceStore {
  return {
    isDecided: () => decided,
    recordLabel: async () => true,
  } as unknown as WorkspaceStore
}

/** The live settings every case runs with. */
const SETTINGS: DecisionSettings = {
  enabled: true,
  provider: '',
  model: '',
  candidates: ['k', 'tinybots'],
  unknownLabel: 'unknown workspace',
  threshold: 0.5,
}

/** Collect one provider call from a scripted classification answer. */
function fixture(options: {
  readonly chunks?: readonly StreamChunk[]
  readonly decided?: boolean
  readonly route?: { readonly provider: string; readonly model: string } | undefined
  readonly hold?: boolean
} = {}): {
  readonly provider: ReturnType<typeof createTitleProvider>
  /** Mutable, so a case reads the count AFTER the call rather than at destructuring time. */
  readonly state: { calls: number; debug: string[] }
} {
  const state = { calls: 0, debug: [] as string[] }
  const chunks = options.chunks ?? [
    { type: 'text-delta', index: 0, text: '{"label":"k","confidence":0.9,"summary":"fix order sync"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ] as readonly StreamChunk[]
  const ledger = new DecisionLedger({
    stream: () => {
      state.calls += 1
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
    store: () => storeFixture(options.decided ?? false),
    settings: () => SETTINGS,
    promptOf: () => 'please fix the tinybots order sync',
    routeOf: () => options.route === undefined ? { provider: 'p', model: 'm' } : options.route,
    debug: message => { state.debug.push(message) },
  })
  return { provider: createTitleProvider(ledger), state }
}

describe('the title provider identity', () => {
  it('registers under the plugin id, on the first prompt', () => {
    const { provider } = fixture()
    expect(provider.id).toBe(TITLE_PROVIDER_ID)
    expect(String(provider.id)).toBe('dsh-session-workspaces')
    expect(provider.automatic).toBe('first-prompt')
  })
})

describe('the title provider result', () => {
  it('returns the summary as the title, with the seqs and route the service validates', async () => {
    const { provider } = fixture()
    const result = await provider.generate({
      session: sessionFixture(),
      messages: [
        { seq: SessionSeq(4), text: 'please fix the tinybots order sync' },
        { seq: SessionSeq(9), text: 'and the report too' },
      ],
      signal: new AbortController().signal,
    })
    expect(result.title).toBe('fix order sync')
    // The FIRST element of the snapshot, never an invented seq.
    expect(result.messageSeqs).toEqual([4])
    expect(result.model).toEqual({ provider: 'p', model: 'm' })
  })

  it('reports the route the classification actually ran on', async () => {
    const { provider } = fixture({ route: { provider: 'other-p', model: 'other-m' } })
    const result = await provider.generate({
      session: sessionFixture(),
      messages: [{ seq: SessionSeq(1), text: 'x' }],
      signal: new AbortController().signal,
    })
    expect(result.model).toEqual({ provider: 'other-p', model: 'other-m' })
  })

  it('throws on a request that carries no human message', async () => {
    const { provider, state } = fixture()
    await expect(provider.generate({
      session: sessionFixture(),
      messages: [],
      signal: new AbortController().signal,
    })).rejects.toThrow(/no human message/u)
    expect(state.calls).toBe(0)
  })

  it('throws when the answer carried no summary, leaving the core fallback in charge', async () => {
    const { provider } = fixture({
      chunks: [
        { type: 'text-delta', index: 0, text: '{"label":"k","confidence":0.9}' },
        { type: 'finish', reason: { kind: 'stop' } },
      ] as readonly StreamChunk[],
    })
    await expect(provider.generate({
      session: sessionFixture(),
      messages: [{ seq: SessionSeq(1), text: 'x' }],
      signal: new AbortController().signal,
    })).rejects.toThrow(/without a summary/u)
  })

  it('throws when the decision was skipped, naming why', async () => {
    const { provider, state } = fixture({ decided: true })
    await expect(provider.generate({
      session: sessionFixture(),
      messages: [{ seq: SessionSeq(1), text: 'x' }],
      signal: new AbortController().signal,
    })).rejects.toThrow(/no title summary \(already-decided\)/u)
    // A decided Session is never re-decided: no model call, no title.
    expect(state.calls).toBe(0)
  })

  it('throws when the classification failed', async () => {
    const { provider } = fixture({
      chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter' } } }] as readonly StreamChunk[],
    })
    await expect(provider.generate({
      session: sessionFixture(),
      messages: [{ seq: SessionSeq(1), text: 'x' }],
      signal: new AbortController().signal,
    })).rejects.toThrow(/no title summary \(provider-error\)/u)
  })
})

describe('the title provider wait', () => {
  it('joins the one decision and never starts a second model call', async () => {
    const { provider, state } = fixture()
    const request = {
      session: sessionFixture(),
      messages: [{ seq: SessionSeq(1), text: 'x' }],
      signal: new AbortController().signal,
    }
    // Two callers, one Session: the service and the header-driven path can both
    // ask, and they must share the single call.
    const [first, second] = await Promise.all([provider.generate(request), provider.generate(request)])
    expect(first.title).toBe('fix order sync')
    expect(second.title).toBe('fix order sync')
    expect(state.calls).toBe(1)
    // The decision is reported once, and the report names the title it produced.
    expect(state.debug).toHaveLength(1)
    expect(state.debug[0]).toContain('title "fix order sync"')
  })

  it('aborts the wait when the request is superseded', async () => {
    const controller = new AbortController()
    const state = { calls: 0 }
    const ledger = new DecisionLedger({
      stream: () => {
        state.calls += 1
        return (async function* (): AsyncIterable<StreamChunk> {
          // A decision that never settles on its own is exactly what the
          // cancellation exists for.
          await new Promise(() => {})
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        })()
      },
      store: () => storeFixture(false),
      settings: () => SETTINGS,
      promptOf: () => 'x',
      routeOf: () => ({ provider: 'p', model: 'm' }),
      debug: () => {},
    })
    const pending = createTitleProvider(ledger).generate({
      session: sessionFixture(),
      messages: [{ seq: SessionSeq(1), text: 'x' }],
      signal: controller.signal,
    })
    controller.abort(new Error('a Human rename superseded this title'))
    await expect(pending).rejects.toThrow('a Human rename superseded this title')
    expect(state.calls).toBe(1)
  })

  it('refuses immediately when the signal is already aborted', async () => {
    const { provider, state } = fixture()
    const controller = new AbortController()
    controller.abort(new Error('the Session was disposed'))
    await expect(provider.generate({
      session: sessionFixture(),
      messages: [{ seq: SessionSeq(1), text: 'x' }],
      signal: controller.signal,
    })).rejects.toThrow('the Session was disposed')
    expect(state.calls).toBe(0)
  })
})
