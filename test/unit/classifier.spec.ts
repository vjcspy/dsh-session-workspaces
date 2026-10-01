/**
 * The classifier's contract: route resolution, answer validation, and the fact
 * that a failure records nothing.
 *
 * The call itself is driven through a scripted stream, so every branch the plan
 * names — in-set, out-of-set, low confidence, malformed, deadline, provider error
 * — is exercised without a model.
 */

import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  classify, parseClassification, resolveRoute, routeFromHeader, CLASSIFIER_SYSTEM_PROMPT,
  buildUserMessage, MAX_PROMPT_CHARS,
} from '../../src/host/classifier.ts'

/** The candidate set every case validates against. */
const CANDIDATES = ['k', 'tinybots', 'whill']

/** Collect one classification from a scripted chunk list. */
async function run(
  chunks: readonly StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>),
  overrides: Partial<Parameters<typeof classify>[1]> = {},
): Promise<{ readonly outcome: Awaited<ReturnType<typeof classify>>; readonly options: GenerateOptions[] }> {
  const options: GenerateOptions[] = []
  const stream = (received: GenerateOptions): AsyncIterable<StreamChunk> => {
    options.push(received)
    return typeof chunks === 'function' ? chunks(received) : (async function* () { for (const chunk of chunks) yield chunk })()
  }
  const outcome = await classify({ stream }, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    prompt: 'please fix the tinybots backend order sync',
    candidates: CANDIDATES,
    unknownLabel: 'unknown workspace',
    threshold: 0.5,
    ...overrides,
  })
  return { outcome, options }
}

/** A clean answer: one text block, then `stop`. */
function answer(label: string, confidence: number): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text: JSON.stringify({ label, confidence }) },
    { type: 'finish', reason: { kind: 'stop' } },
  ] as StreamChunk[]
}

/** A finish chunk with an arbitrary reason, cast to the merge-extensible union. */
function finish(reason: unknown): StreamChunk {
  return { type: 'finish', reason } as StreamChunk
}

describe('resolveRoute', () => {
  it('prefers a complete configured pair', () => {
    expect(resolveRoute(
      { provider: 'p', model: 'm' },
      { provider: 'session-p', model: 'session-m' },
    )).toEqual({ provider: 'p', model: 'm', source: 'config' })
  })

  it('falls back to the Session\'s own logged route', () => {
    expect(resolveRoute({ provider: '', model: '' }, { provider: 'sp', model: 'sm' }))
      .toEqual({ provider: 'sp', model: 'sm', source: 'session' })
  })

  it('answers "none" when neither source resolves, so no call is made', () => {
    expect(resolveRoute({ provider: '', model: '' }, undefined))
      .toEqual({ provider: '', model: '', source: 'none' })
  })

  it('does not complete a half-configured pair from the other source', () => {
    expect(resolveRoute({ provider: 'p', model: '' }, { provider: 'sp', model: 'sm' }).source).toBe('session')
    expect(resolveRoute({ provider: 'p', model: '' }, undefined).source).toBe('none')
    expect(resolveRoute({ provider: '   ', model: '   ' }, undefined).source).toBe('none')
  })
})

describe('routeFromHeader', () => {
  it('reads a complete pair', () => {
    expect(routeFromHeader({ config: { provider: 'p', model: 'm' } })).toEqual({ provider: 'p', model: 'm' })
  })

  it('refuses an incomplete, mistyped or absent header', () => {
    expect(routeFromHeader(undefined)).toBeUndefined()
    expect(routeFromHeader({})).toBeUndefined()
    expect(routeFromHeader({ config: { provider: 'p' } })).toBeUndefined()
    expect(routeFromHeader({ config: { provider: '', model: 'm' } })).toBeUndefined()
    expect(routeFromHeader({ config: { provider: 1, model: 2 } })).toBeUndefined()
  })
})

describe('parseClassification', () => {
  const input = { candidates: CANDIDATES, unknownLabel: 'unknown workspace', threshold: 0.5 }

  it('accepts an in-set label and clamps confidence', () => {
    expect(parseClassification('{"label":"k","confidence":0.9}', input)).toEqual({ label: 'k', confidence: 0.9 })
    expect(parseClassification('{"label":"k","confidence":9}', input)).toEqual({ label: 'k', confidence: 1 })
  })

  it('matches the label case-insensitively against the candidate set', () => {
    expect(parseClassification('{"label":"TinyBots","confidence":0.8}', input)?.label).toBe('tinybots')
  })

  it('maps an out-of-set label to the unknown label', () => {
    expect(parseClassification('{"label":"shopify","confidence":0.99}', input))
      .toEqual({ label: 'unknown workspace', confidence: 0.99 })
  })

  it('maps a below-threshold answer to the unknown label', () => {
    expect(parseClassification('{"label":"k","confidence":0.4}', input))
      .toEqual({ label: 'unknown workspace', confidence: 0.4 })
  })

  it('keeps the unknown label when the model chose it', () => {
    expect(parseClassification('{"label":"unknown workspace","confidence":0.1}', input))
      .toEqual({ label: 'unknown workspace', confidence: 0.1 })
  })

  it('treats a missing confidence as undecided', () => {
    expect(parseClassification('{"label":"k"}', input)).toEqual({ label: 'unknown workspace', confidence: 0 })
  })

  it('reads JSON out of prose or a fenced block', () => {
    expect(parseClassification('Sure:\n```json\n{"label":"whill","confidence":0.7}\n```', input)?.label).toBe('whill')
  })

  it('refuses a malformed answer', () => {
    for (const text of ['', 'k', '["k"]', '{"confidence":0.9}', '{"label":""}', '{"label":42}', '{oops']) {
      expect(parseClassification(text, input), text).toBeUndefined()
    }
  })
})

describe('classify', () => {
  it('records an in-set answer', async () => {
    const { outcome } = await run(answer('tinybots', 0.9))
    expect(outcome).toMatchObject({ ok: true, label: 'tinybots', confidence: 0.9 })
  })

  it('records the unknown label for an out-of-set answer', async () => {
    const { outcome } = await run(answer('shopify', 0.95))
    expect(outcome).toMatchObject({ ok: true, label: 'unknown workspace' })
  })

  it('records the unknown label for a low-confidence answer', async () => {
    const { outcome } = await run(answer('k', 0.2))
    expect(outcome).toMatchObject({ ok: true, label: 'unknown workspace', confidence: 0.2 })
  })

  it('records nothing for an unparseable answer', async () => {
    const { outcome } = await run([{ type: 'text-delta', index: 0, text: 'I think it is k' }, finish({ kind: 'stop' })])
    expect(outcome).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('records nothing when the provider reports a failure through its finish reason', async () => {
    const { outcome } = await run([
      finish({ kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter registered' } }),
    ])
    expect(outcome).toMatchObject({ ok: false, reason: 'provider-error', message: 'no adapter registered' })
  })

  it('records nothing when the stream rejects', async () => {
    const { outcome } = await run(() => (async function* (): AsyncIterable<StreamChunk> {
      throw new Error('socket closed')
    })())
    expect(outcome).toMatchObject({ ok: false, reason: 'provider-error', message: 'socket closed' })
  })

  it('records nothing when a stalled adapter passes the deadline', async () => {
    const { outcome } = await run(() => (async function* (): AsyncIterable<StreamChunk> {
      await new Promise(() => {})
      yield finish({ kind: 'stop' })
    })(), { timeoutMs: 20 })
    expect(outcome).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('treats a max-tokens stop as a provider failure rather than a partial label', async () => {
    const { outcome } = await run([
      { type: 'text-delta', index: 0, text: '{"label":"k","confi' },
      finish({ kind: 'max-tokens' }),
    ])
    expect(outcome).toMatchObject({ ok: false, reason: 'provider-error' })
  })

  it('sends no sessionId, no purpose, and its own system prompt', async () => {
    const { options } = await run(answer('k', 0.9))
    const received = options[0]
    expect(received).toBeDefined()
    expect('sessionId' in (received as object)).toBe(false)
    expect('purpose' in (received as object)).toBe(false)
    expect(received?.provider).toBe('deepseek-official')
    expect(received?.model).toBe('deepseek-v4-flash')
    expect(received?.system).toBe(CLASSIFIER_SYSTEM_PROMPT)
    expect(received?.temperature).toBe(0)
    expect(received?.signal).toBeInstanceOf(AbortSignal)
    // A single user message: the plugin owns the whole prompt, so nothing of the
    // conversation is replayed and nothing is added to it.
    expect(received?.messages).toHaveLength(1)
    expect((received?.messages[0] as { role?: string } | undefined)?.role).toBe('user')
  })

  it('closes the candidate set and truncates a huge prompt in the user message', () => {
    const message = buildUserMessage({
      candidates: CANDIDATES,
      unknownLabel: 'unknown workspace',
      prompt: 'x'.repeat(MAX_PROMPT_CHARS + 500),
    })
    expect(message).toContain(JSON.stringify(CANDIDATES))
    expect(message).toContain('unknown workspace')
    expect(message).toContain('[truncated]')
    expect(message.length).toBeLessThan(MAX_PROMPT_CHARS + 1_000)
  })
})
