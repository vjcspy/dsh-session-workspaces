/**
 * The backfill's contract: how a stored Session's first prompt and logged route
 * are read, that it never runs unasked, that it skips what is already decided,
 * that its calls are bounded, and that one failure does not abort a pass.
 */

import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Backfill } from '../../src/host/backfill.ts'
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
} = {}): { readonly backfill: Backfill; readonly store: WorkspaceStore } {
  const store = overrides.store ?? new WorkspaceStore(new FakeDomain(), { now: () => 'T', newId: () => 'g' })
  const stream = overrides.stream ?? answering('k')
  const backfill = new Backfill({
    store,
    listSessions: async () => overrides.records ?? [record('s1')],
    readSession: async (id) => ({ events: overrides.events?.(id) ?? [prompt('work on the k repo'), header('p', 'm')] }),
    stream,
    settings: () => ({
      provider: overrides.route?.provider ?? '',
      model: overrides.route?.model ?? '',
      candidates: ['k', 'tinybots'],
      unknownLabel: 'unknown workspace',
      threshold: 0.5,
    }),
    log: () => {},
    now: () => '2026-10-01T00:00:00.000Z',
    ...overrides.concurrency === undefined ? {} : { concurrency: overrides.concurrency },
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
    expect(backfill.snapshot()).toMatchObject({ classified: 1, failed: 0, running: false })
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
    expect(backfill.snapshot()).toMatchObject({ failed: 1, classified: 0 })
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
    expect(backfill.snapshot()).toMatchObject({ total: 1, classified: 1, skipped: 2 })
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
    expect(backfill.snapshot()).toMatchObject({ running: false, failed: 2, classified: 0 })
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
