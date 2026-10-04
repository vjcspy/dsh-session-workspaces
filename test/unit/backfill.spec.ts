/**
 * The backfill's contract: how a stored Session's first prompt and logged route
 * are read, that it never runs unasked, that it skips what is already decided,
 * that its calls are bounded, and that one failure does not abort a pass.
 *
 * Plus the reporting contract: a log with no human prompt is its own outcome and
 * never sets `lastError`, every failure is attributed to its own class beside a
 * bounded in-memory list, and a write that stored the unknown label is visible as
 * a subset of `classified`.
 */

import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Backfill } from '../../src/host/backfill.ts'
import type { BackfillStatus } from '../../src/wire.ts'
import { firstHumanPrompt, humanPromptText, routeFromEvents } from '../../src/host/session-log.ts'
import { WorkspaceStore } from '../../src/host/store.ts'
import { FakeDomain } from '../support/fake-domain.ts'

/** One stored session record as the corpus reports it. */
function record(id: string, overrides: Partial<{ cwd: string; parent: unknown }> = {}) {
  return { id, cwd: overrides.cwd ?? '/Users/example/aweave', parent: overrides.parent }
}

/** One human prompt event. */
function prompt(text: string): { type: string; data: unknown } {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

/** The live settings the backfill reads at the moment of each call. */
interface BackfillSettings {
  readonly provider: string
  readonly model: string
  readonly candidates: readonly string[]
  readonly unknownLabel: string
  readonly threshold: number
}

/** One request-header event carrying a route. */
function header(provider: string, model: string): { type: string; data: unknown } {
  return { type: 'request/header', data: { header: { config: { provider, model } } } }
}

/** A stream that answers one JSON label. */
function answering(label: string): (options: GenerateOptions) => AsyncIterable<StreamChunk> {
  return () => (async function* () {
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ label, confidence: 0.9 }) } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  })()
}

/** Build a backfill over the in-memory double. */
function makeBackfill(overrides: {
  readonly records?: readonly { id: string; cwd: string | undefined; parent: unknown }[]
  readonly events?: (id: string) => readonly { type: string; data?: unknown }[]
  readonly stream?: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  readonly store?: WorkspaceStore
  readonly concurrency?: number
  readonly route?: { provider: string; model: string }
  readonly readSession?: (id: string) => Promise<{ readonly events: readonly { type: string; data?: unknown }[] }>
  readonly settings?: () => BackfillSettings
  readonly timeoutMs?: number
  readonly log?: (message: string) => void
} = {}): { readonly backfill: Backfill; readonly store: WorkspaceStore } {
  const store = overrides.store ?? new WorkspaceStore(new FakeDomain(), { now: () => 'T', newId: () => 'g' })
  const stream = overrides.stream ?? answering('k')
  const backfill = new Backfill({
    store,
    listSessions: async () => overrides.records ?? [record('s1')],
    readSession: overrides.readSession
      ?? (async (id) => ({ events: overrides.events?.(id) ?? [prompt('work on the k repo'), header('p', 'm')] })),
    stream,
    settings: overrides.settings ?? (() => ({
      provider: overrides.route?.provider ?? '',
      model: overrides.route?.model ?? '',
      candidates: ['k', 'tinybots'],
      unknownLabel: 'unknown workspace',
      threshold: 0.5,
    })),
    log: overrides.log ?? (() => {}),
    now: () => '2026-10-01T00:00:00.000Z',
    ...overrides.concurrency === undefined ? {} : { concurrency: overrides.concurrency },
    ...overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs },
  })
  return { backfill, store }
}

/** Wait until a pass settles. */
async function settle(backfill: Backfill): Promise<void> {
  for (let attempt = 0; attempt < 200 && backfill.snapshot().running; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('reading a stored Session', () => {
  it('takes the first human prompt and skips non-human and empty messages', () => {
    expect(firstHumanPrompt([
      { type: 'user/message', data: { source: { kind: 'agent' }, content: [{ type: 'text', text: 'from a tool' }] } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image' }] } },
      prompt('the real first prompt'),
      prompt('a later prompt'),
    ])).toBe('the real first prompt')
  })

  it('refuses a log with no human prompt', () => {
    expect(firstHumanPrompt([header('p', 'm')])).toBeUndefined()
    expect(humanPromptText({ source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] })).toBeUndefined()
  })

  it('reads the LAST logged route, and refuses an incomplete one', () => {
    expect(routeFromEvents([header('a', 'b'), header('c', 'd')])).toEqual({ provider: 'c', model: 'd' })
    expect(routeFromEvents([
      header('a', 'b'),
      { type: 'request/header', data: { header: { config: { provider: 'c' } } } },
    ])).toEqual({ provider: 'a', model: 'b' })
    expect(routeFromEvents([])).toBeUndefined()
  })
})

describe('the pass', () => {
  it('never runs without an explicit start', async () => {
    let calls = 0
    const { backfill } = makeBackfill({ stream: () => { calls += 1; return answering('k')({} as GenerateOptions) } })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toBe(0)
    expect(backfill.snapshot().running).toBe(false)
    expect(backfill.snapshot().finishedAt).toBeUndefined()
  })

  it('classifies an unclassified stored Session through its own logged route', async () => {
    const { backfill, store } = makeBackfill()
    await backfill.start()
    await settle(backfill)
    // `makeBackfill` pins the clock to 'T' so the record is exactly assertable.
    expect(store.labelOf('s1')).toEqual({ workspace: 'k', confidence: 0.9, decidedAt: 'T' })
    expect(backfill.snapshot()).toMatchObject({
      classified: 1, unknown: 0, failed: 0, noPrompt: 0, running: false,
      recentFailures: [],
    })
  })

  it('prefers the configured route over the logged one', async () => {
    const seen: GenerateOptions[] = []
    const { backfill } = makeBackfill({
      route: { provider: 'cfg-p', model: 'cfg-m' },
      stream: (options) => { seen.push(options); return answering('k')(options) },
    })
    await backfill.start()
    await settle(backfill)
    expect(seen[0]?.provider).toBe('cfg-p')
  })

  it('records nothing for a Session with no route, and counts it as a failure', async () => {
    const { backfill, store } = makeBackfill({ events: () => [prompt('no route here')] })
    await backfill.start()
    await settle(backfill)
    expect(store.labelOf('s1')).toBeUndefined()
    expect(backfill.snapshot()).toMatchObject({ failed: 1, classified: 0, noPrompt: 0 })
    expect(backfill.snapshot().failures).toMatchObject({ route: 1 })
    expect(backfill.snapshot().lastError).toContain('no route')
  })

  it('skips a Session that is already classified or pinned, so a re-run resumes', async () => {
    const store = new WorkspaceStore(new FakeDomain(), { now: () => 'T', newId: () => 'g' })
    await store.recordLabel('s1', 'whill', 0.7)
    await store.assign({ sessionId: 's2', workspace: 'k' })
    const { backfill } = makeBackfill({
      store,
      records: [record('s1'), record('s2'), record('s3')],
      events: () => [prompt('third session'), header('p', 'm')],
    })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot()).toMatchObject({ total: 1, classified: 1, unknown: 0, skipped: 2, noPrompt: 0 })
    // The pinned Session was never rewritten.
    expect(store.pinOf('s2')?.workspace).toBe('k')
    expect(store.labelOf('s1')?.workspace).toBe('whill')
  })

  it('ignores child Sessions', async () => {
    let calls = 0
    const { backfill } = makeBackfill({
      records: [record('child', { parent: 'parent' })],
      stream: (options) => { calls += 1; return answering('k')(options) },
    })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot().total).toBe(0)
    expect(calls).toBe(0)
  })

  it('keeps a failure inside its own Session and finishes the pass', async () => {
    const { backfill, store } = makeBackfill({
      records: [record('bad'), record('good')],
      events: id => id === 'bad'
        ? [prompt('boom'), header('p', 'm')]
        : [prompt('fine'), header('p', 'm')],
      stream: () => (async function* (): AsyncIterable<StreamChunk> {
        throw new Error('provider exploded')
      })(),
    })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot()).toMatchObject({ running: false, failed: 2, classified: 0, noPrompt: 0 })
    expect(backfill.snapshot().failures).toMatchObject({ providerError: 2 })
    expect(store.labelOf('bad')).toBeUndefined()
  })

  it('bounds how many calls are in flight at once', async () => {
    let live = 0
    let peak = 0
    const { backfill } = makeBackfill({
      records: Array.from({ length: 8 }, (_, index) => record(`s${index}`)),
      events: () => [prompt('work'), header('p', 'm')],
      concurrency: 2,
      stream: () => (async function* () {
        live += 1
        peak = Math.max(peak, live)
        await new Promise(resolve => setTimeout(resolve, 2))
        yield { type: 'text-delta', index: 0, text: '{"label":"k","confidence":0.9}' } as StreamChunk
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        live -= 1
      })(),
    })
    await backfill.start()
    await settle(backfill)
    expect(peak).toBeLessThanOrEqual(2)
    expect(backfill.snapshot().classified).toBe(8)
  })

  it('refuses to start a second pass while one is running', async () => {
    let calls = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = () => { resolve() } })
    const { backfill } = makeBackfill({
      records: [record('s1'), record('s2')],
      stream: () => {
        calls += 1
        return (async function* () {
          await gate
          yield { type: 'text-delta', index: 0, text: '{"label":"k","confidence":0.9}' } as StreamChunk
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        })()
      },
    })
    await backfill.start()
    const second = await backfill.start()
    expect(second.running).toBe(true)
    release()
    await settle(backfill)
    // Two Sessions, one pass: a second pass would have made four calls.
    expect(calls).toBe(2)
  })
})

describe('the pass reports what it actually did', () => {
  it('reports a log with no message record as its own outcome, not a failure', async () => {
    // The live shape: a 6-record log — session, permission/preset, sandbox/mode,
    // approval/policy, subagent/model-selection-policy, session/end-seed.
    const { backfill } = makeBackfill({ events: () => [] })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot()).toMatchObject({ total: 1, done: 1, noPrompt: 1, failed: 0, classified: 0 })
    expect(backfill.snapshot().lastError).toBeUndefined()
    expect(backfill.snapshot().recentFailures).toEqual([])
  })

  it('reports a log whose only messages are non-human as the same outcome', async () => {
    // 26 of the live corpus's 31 unclassifiable Sessions are agent-authored.
    const { backfill } = makeBackfill({
      events: () => [
        { type: 'user/message', data: { source: { kind: 'agent' }, content: [{ type: 'text', text: 'from the route' }] } },
        header('p', 'm'),
      ],
    })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot()).toMatchObject({ total: 1, done: 1, noPrompt: 1, failed: 0 })
    expect(backfill.snapshot().lastError).toBeUndefined()
  })

  it('counts a write that stored the unknown label as a subset of classified', async () => {
    const { backfill, store } = makeBackfill({ stream: answering('unknown workspace') })
    await backfill.start()
    await settle(backfill)
    expect(store.labelOf('s1')?.workspace).toBe('unknown workspace')
    expect(backfill.snapshot()).toMatchObject({ classified: 1, unknown: 1, skipped: 0, failed: 0 })
  })

  it('counts a write the store refused as a skip, never as unknown', async () => {
    const store = new WorkspaceStore(new FakeDomain(), { now: () => 'T', newId: () => 'g' })
    const { backfill } = makeBackfill({
      store,
      // The Human pins the Session while its classification call is in flight, so
      // `recordLabel` refuses the write and nothing is counted as classified.
      stream: () => (async function* () {
        await store.assign({ sessionId: 's1', workspace: 'k' })
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ label: 'unknown workspace', confidence: 0.9 }) } as StreamChunk
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      })(),
    })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot()).toMatchObject({ classified: 0, unknown: 0, skipped: 1, failed: 0 })
    expect(store.pinOf('s1')?.workspace).toBe('k')
  })

  it('keeps a real failure and a prompt-less Session apart in one pass', async () => {
    const { backfill } = makeBackfill({
      records: [record('noprompt'), record('broken')],
      events: id => id === 'noprompt' ? [] : [prompt('boom'), header('p', 'm')],
      concurrency: 1,
      stream: () => (async function* (): AsyncIterable<StreamChunk> {
        throw new Error('provider exploded')
      })(),
    })
    await backfill.start()
    await settle(backfill)
    const status = backfill.snapshot()
    expect(status).toMatchObject({ total: 2, done: 2, noPrompt: 1, failed: 1, classified: 0 })
    // `lastError` is one overwritten string, so it must name the REAL failure.
    expect(status.lastError).toContain('broken')
    expect(status.recentFailures.map(entry => entry.sessionId)).toEqual(['broken'])
  })
})

describe('the failure classes', () => {
  it('counts a missing route as `route`, and spends no model call', async () => {
    let calls = 0
    const { backfill } = makeBackfill({
      events: () => [prompt('no route here')],
      stream: () => { calls += 1; return answering('k')({} as GenerateOptions) },
    })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot().failures).toEqual(
      { read: 0, route: 1, timeout: 0, providerError: 0, malformed: 0, other: 0 },
    )
    expect(calls).toBe(0)
  })

  it('counts a stalled adapter that passed the deadline as `timeout`', async () => {
    const { backfill } = makeBackfill({
      timeoutMs: 20,
      stream: () => (async function* (): AsyncIterable<StreamChunk> {
        await new Promise(() => {})
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      })(),
    })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot().failures).toMatchObject({ timeout: 1 })
    expect(backfill.snapshot().failures.providerError).toBe(0)
    expect(backfill.snapshot().recentFailures[0]).toMatchObject({ sessionId: 's1', kind: 'timeout' })
    expect(backfill.snapshot().recentFailures[0]?.message).toContain('classification exceeded 20ms')
  })

  it('counts a thrown stream as `providerError`', async () => {
    const { backfill } = makeBackfill({
      stream: () => (async function* (): AsyncIterable<StreamChunk> {
        throw new Error('provider exploded')
      })(),
    })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot().failures).toMatchObject({ providerError: 1 })
    expect(backfill.snapshot().recentFailures[0]?.kind).toBe('providerError')
  })

  it('counts an unusable answer as `malformed`, separately from a provider error', async () => {
    const { backfill } = makeBackfill({
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: 'DONE' } as StreamChunk
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      })(),
    })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot().failures).toMatchObject({ malformed: 1 })
    expect(backfill.snapshot().failures.providerError).toBe(0)
    expect(backfill.snapshot().recentFailures[0]).toMatchObject({ kind: 'malformed', message: 's1: malformed — DONE' })
  })

  it('counts an unreadable log as `read`, and keeps its diagnostic and its id', async () => {
    const logged: string[] = []
    const { backfill } = makeBackfill({
      log: message => { logged.push(message) },
      readSession: async () => { throw new Error('x'.repeat(500)) },
    })
    await backfill.start()
    await settle(backfill)
    const status = backfill.snapshot()
    expect(status.failures).toMatchObject({ read: 1, other: 0, route: 0, providerError: 0, malformed: 0 })
    expect(status.lastError).toBe(`s1: ${'x'.repeat(500)}`)
    // The read failure keeps the sink the outer catch writes to.
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('backfill failed for s1')
    // The truncation happens AFTER the id prefix, so the id survives the cap.
    expect(status.recentFailures[0]?.kind).toBe('read')
    expect(status.recentFailures[0]?.message).toHaveLength(200)
    expect(status.recentFailures[0]?.message.startsWith('s1: ')).toBe(true)
  })

  it('counts anything else as `other`', async () => {
    const { backfill } = makeBackfill({
      settings: () => { throw new Error('settings exploded') },
    })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot().failures).toMatchObject({ other: 1, read: 0, route: 0, timeout: 0 })
    expect(backfill.snapshot().recentFailures[0]).toMatchObject({ sessionId: 's1', kind: 'other' })
  })
})

describe('the recent-failure list', () => {
  it('keeps the ten newest, and the next pass replaces both the tally and the list', async () => {
    const records = Array.from({ length: 12 }, (_, index) => record(`s${index}`))
    const { backfill } = makeBackfill({
      records,
      events: () => [prompt('work'), header('p', 'm')],
      concurrency: 1,
      stream: () => (async function* (): AsyncIterable<StreamChunk> {
        throw new Error('provider exploded')
      })(),
    })
    await backfill.start()
    await settle(backfill)
    const first: BackfillStatus = backfill.snapshot()
    expect(first.failures.providerError).toBe(12)
    expect(first.recentFailures).toHaveLength(10)
    expect(first.recentFailures.map(entry => entry.sessionId)).toEqual(
      ['s11', 's10', 's9', 's8', 's7', 's6', 's5', 's4', 's3', 's2'],
    )
    // A second pass over one failing Session reports that pass alone.
    records.splice(0, records.length, record('s1'))
    await backfill.start()
    await settle(backfill)
    const second: BackfillStatus = backfill.snapshot()
    expect(second.failures.providerError).toBe(1)
    expect(second.recentFailures).toHaveLength(1)
    expect(second.recentFailures[0]?.sessionId).toBe('s1')
  })

  it('never runs the report forward when a pass has nothing to do', async () => {
    const store = new WorkspaceStore(new FakeDomain(), { now: () => 'T', newId: () => 'g' })
    await store.recordLabel('s1', 'k', 0.9)
    const { backfill } = makeBackfill({ store })
    await backfill.start()
    await settle(backfill)
    expect(backfill.snapshot()).toMatchObject({
      total: 0, done: 0, classified: 0, unknown: 0, failed: 0, noPrompt: 0, recentFailures: [],
    })
  })
})
