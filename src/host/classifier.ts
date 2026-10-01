/**
 * The classifier: one hidden auxiliary model call that decides which Aweave
 * workspace a conversation belongs to.
 *
 * Three properties are contractual, and each is visible in the code below:
 *
 * - **Nothing is appended to the conversation surface.** The call goes through
 *   `ctx.llm.stream` with its own system prompt and messages and writes no
 *   Session event, so it never becomes conversation context. The in-repo
 *   precedent is `packages/experimental/auto-review`, the only auxiliary caller
 *   that also omits `sessionId`.
 * - **No `sessionId`.** `session-checkpoint-policy` wraps an `llm/stream` call
 *   in a durable checkpoint when — and only when — it carries a `sessionId`
 *   that resolves to a live Session. Omitting it keeps this call out of the
 *   Session's checkpoint traffic.
 * - **The route is resolved explicitly, and never invented.** Config
 *   `provider`/`model`, else the Session's own logged route from its
 *   `request/header`, else there is no call at all and nothing is recorded.
 *
 * The module is deliberately free of Cordis: it takes the stream function as a
 * parameter, so every branch is unit-testable without a host context.
 *
 * @module dsh-session-workspaces/host/classifier
 */

import { BlockAssembler, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CLASSIFY_TIMEOUT_MS } from '../config.ts'

/** How much of a first prompt the classifier is shown; a longer one is truncated. */
export const MAX_PROMPT_CHARS = 8_000

/** Where a resolved route came from. `none` means: do not call. */
export type RouteSource = 'config' | 'session' | 'none'

/** One resolved route. */
export interface ClassificationRoute {
  /** Provider id, empty when no route resolved. */
  readonly provider: string
  /** Model id, empty when no route resolved. */
  readonly model: string
  /** Which source answered. */
  readonly source: RouteSource
}

/** A provider/model pair as the Session's own log reports it. */
export interface SessionRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Resolve the classification route.
 *
 * Config first, because a Human who set it means it; then the Session's own
 * logged route, which works out of the box on a fresh install because the
 * Session already has one. A half-configured pair (provider without model) is
 * treated as unconfigured rather than completed from the other source: a mixed
 * route is a route nobody chose.
 * @param config - configured provider/model, either of which may be empty.
 * @param session - the Session's own logged route, when its header was recorded.
 * @returns the route; `source: 'none'` when nothing resolved.
 */
export function resolveRoute(
  config: { readonly provider: string; readonly model: string },
  session: SessionRoute | undefined,
): ClassificationRoute {
  const provider = config.provider.trim()
  const model = config.model.trim()
  if (provider !== '' && model !== '') return { provider, model, source: 'config' }
  if (session !== undefined && session.provider.trim() !== '' && session.model.trim() !== '') {
    return { provider: session.provider.trim(), model: session.model.trim(), source: 'session' }
  }
  return { provider: '', model: '', source: 'none' }
}

/**
 * Read the Session's logged route out of a `request/header` payload.
 * @param header - the event's `header` payload, of unknown shape.
 * @returns the pair, or undefined when the payload carries no complete route.
 */
export function routeFromHeader(header: unknown): SessionRoute | undefined {
  const config = (header as { config?: { provider?: unknown; model?: unknown } } | null | undefined)?.config
  const provider = config?.provider
  const model = config?.model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  if (provider.trim() === '' || model.trim() === '') return undefined
  return { provider, model }
}

/** The fixed instruction the classifier runs under. Closed set, JSON out, no prose. */
export const CLASSIFIER_SYSTEM_PROMPT = [
  'You label one conversation with the Aweave workspace it belongs to.',
  '',
  'The workspaces are directories under the Aweave repository root `workspaces/`.',
  'Decide from the Human\'s first message ALONE — the files, paths, repositories and',
  'domain names it mentions — and answer with the single best label.',
  '',
  'Rules:',
  '- Answer with ONE label, chosen EXACTLY from the candidate list you are given.',
  '- Choose the unknown label when the message carries no usable signal, or when the',
  '  signal points somewhere outside the candidate list.',
  '- Report your confidence as a number between 0 and 1. Use a value below 0.5 when',
  '  you are guessing; a low-confidence answer is treated as the unknown label.',
  '',
  'Answer with a single JSON object and nothing else:',
  '{"label": "<one candidate label>", "confidence": <number between 0 and 1>}',
].join('\n')

/**
 * Build the user message: the closed candidate set plus the first human prompt.
 * @param input - candidates, the unknown label, and the prompt text.
 * @returns the message text.
 */
export function buildUserMessage(input: {
  readonly candidates: readonly string[]
  readonly unknownLabel: string
  readonly prompt: string
}): string {
  const prompt = input.prompt.length > MAX_PROMPT_CHARS
    ? `${input.prompt.slice(0, MAX_PROMPT_CHARS)}\n…[truncated]`
    : input.prompt
  return [
    'Candidate labels (choose exactly one, verbatim):',
    JSON.stringify(input.candidates),
    '',
    `Answer "${input.unknownLabel}" if the message is undecidable or points outside the list.`,
    '',
    'The Human\'s first message:',
    '"""',
    prompt,
    '"""',
  ].join('\n')
}

/** One accepted answer. */
export interface ClassificationAnswer {
  /** The accepted label, always a member of the candidate set (possibly the unknown label). */
  readonly label: string
  /** Confidence the model reported, clamped to `[0, 1]`. */
  readonly confidence: number
}

/** How one answer is validated. */
export interface ParseInput {
  /** The closed candidate label set. */
  readonly candidates: readonly string[]
  /** Label recorded for out-of-set or low-confidence answers. */
  readonly unknownLabel: string
  /** Minimum accepted confidence. */
  readonly threshold: number
}

/**
 * Validate one model answer against the closed candidate set.
 *
 * A parseable answer ALWAYS becomes a label — out-of-set and below-threshold
 * answers become the unknown label, which is an explicit outcome the Human can
 * correct from the sidebar. Only an answer that is not a JSON object carrying a
 * non-empty `label` string is unparseable, and the caller records nothing for it.
 * @param text - the assembled assistant text.
 * @param input - candidate set, unknown label and threshold.
 * @returns the accepted answer, or undefined when the text is unparseable.
 */
export function parseClassification(text: string, input: ParseInput): ClassificationAnswer | undefined {
  const raw = extractJsonObject(text)
  if (raw === undefined) return undefined
  const reported = raw['label']
  if (typeof reported !== 'string' || reported.trim() === '') return undefined
  const rawConfidence = raw['confidence']
  const confidence = typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : 0
  return {
    // Below the threshold the answer is the unknown label, not a rejection: the
    // Session still lands somewhere explicit and the Human can correct it.
    label: confidence < input.threshold ? input.unknownLabel : canonicalLabel(reported.trim(), input),
    confidence,
  }
}

/**
 * Map one reported label onto the candidate set.
 * @param reported - the label the model wrote.
 * @param input - candidate set, unknown label and threshold.
 * @returns the canonical candidate label, or the unknown label.
 */
function canonicalLabel(reported: string, input: ParseInput): string {
  const unknown = input.unknownLabel
  if (reported.toLowerCase() === unknown.trim().toLowerCase()) return unknown
  const match = input.candidates.find(candidate => candidate.toLowerCase() === reported.toLowerCase())
  return match ?? unknown
}

/**
 * Pull the first JSON object out of a model answer.
 *
 * Models wrap JSON in prose or a fenced code block often enough that demanding a
 * bare object would discard usable answers; demanding an OBJECT is what keeps a
 * bare label from being accepted as one.
 * @param text - the assistant text.
 * @returns the parsed object, or undefined.
 */
function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/** One classification attempt's inputs. */
export interface ClassificationRequest {
  /** Resolved provider id. */
  readonly provider: string
  /** Resolved model id. */
  readonly model: string
  /** The Session's first human prompt. */
  readonly prompt: string
  /** Closed candidate label set. */
  readonly candidates: readonly string[]
  /** Label for undecidable answers. */
  readonly unknownLabel: string
  /** Minimum accepted confidence. */
  readonly threshold: number
  /** Deadline in milliseconds; defaults to {@link CLASSIFY_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined
}

/** What one attempt produced. A failure records nothing and disturbs nothing. */
export type ClassificationOutcome =
  | {
    readonly ok: true
    readonly label: string
    readonly confidence: number
    /** The raw assembled text, kept for the diagnostics a test asserts on. */
    readonly text: string
  }
  | {
    readonly ok: false
    readonly reason: 'timeout' | 'provider-error' | 'malformed'
    readonly message: string
  }

/** The one host capability this module needs. */
export interface ClassifyDeps {
  /** `ctx.llm.stream`, injected so a spec can script every outcome. */
  readonly stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
}

/**
 * Run one classification call.
 *
 * Never throws and never retries: a provider error, a deadline or an
 * unparseable answer is reported as an outcome, because the caller's contract is
 * to record nothing and leave the Session, its turn and the core title feature
 * exactly as they were.
 * @param deps - the stream function.
 * @param request - route, prompt and validation inputs.
 * @returns the outcome.
 */
export async function classify(
  deps: ClassifyDeps,
  request: ClassificationRequest,
): Promise<ClassificationOutcome> {
  const controller = new AbortController()
  const timeoutMs = request.timeoutMs ?? CLASSIFY_TIMEOUT_MS
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  // No `sessionId`: a call carrying a live Session id is wrapped in a durable
  // checkpoint by `session-checkpoint-policy`. No `purpose` either: the field is
  // a closed union with no classifier literal, and `auto-review` — the in-repo
  // precedent for a prompt that never enters a Session log — omits it too.
  const options: GenerateOptions = {
    provider: request.provider,
    model: request.model,
    system: CLASSIFIER_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: buildUserMessage({
          candidates: request.candidates,
          unknownLabel: request.unknownLabel,
          prompt: request.prompt,
        }),
      }],
    }],
    temperature: 0,
    signal: controller.signal,
  }
  const assembler = new BlockAssembler()
  // The deadline is raced against each `next()`, not merely handled after the
  // loop: an adapter that ignores the signal would otherwise stall the `for
  // await` forever and the timeout would never fire. `LlmRuntime.stream` also
  // normalizes an adapter throw into a terminal finish chunk, so a rejection here
  // is a transport-level failure, not the provider's own error report.
  const iterator = deps.stream(options)[Symbol.asyncIterator]()
  try {
    for (;;) {
      const step = await nextChunk(iterator, controller.signal)
      if (step.done === true) break
      assembler.push(step.value)
    }
  } catch (error) {
    if (error === TIMED_OUT || controller.signal.aborted) {
      return { ok: false, reason: 'timeout', message: `classification exceeded ${timeoutMs}ms` }
    }
    return { ok: false, reason: 'provider-error', message: messageOf(error) }
  } finally {
    clearTimeout(timer)
    // Ask the generator to close, but never await it: a stream suspended on an
    // await that will not settle — exactly the stall this deadline exists for —
    // cannot process the return completion, so awaiting it would hang the caller
    // that the timeout just rescued.
    void Promise.resolve(iterator.return?.(undefined)).catch(() => {})
  }
  // `LlmRuntime.stream` normalizes an adapter throw into a terminal `error` or
  // `aborted` finish chunk instead of rethrowing, so the finish reason — not a
  // rejection — is where a provider failure surfaces.
  const failure = terminalFailure(assembler.finish)
  if (failure !== undefined) return { ok: false, reason: 'provider-error', message: failure }
  const text = assembledText(assembler)
  const answer = parseClassification(text, {
    candidates: request.candidates,
    unknownLabel: request.unknownLabel,
    threshold: request.threshold,
  })
  if (answer === undefined) return { ok: false, reason: 'malformed', message: text.slice(0, 400) }
  return { ok: true, label: answer.label, confidence: answer.confidence, text }
}

/** Sentinel rejection for the deadline race; identity-compared, never surfaced. */
const TIMED_OUT = Symbol('dsh-session-workspaces:classification-timeout')

/**
 * Await one stream step, or the deadline.
 * @param iterator - the stream's iterator.
 * @param signal - the deadline signal.
 * @returns the iterator's step.
 */
async function nextChunk(
  iterator: AsyncIterator<StreamChunk>,
  signal: AbortSignal,
): Promise<IteratorResult<StreamChunk>> {
  if (signal.aborted) throw TIMED_OUT
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(TIMED_OUT) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([iterator.next(), aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * The text of one assembled response, or the empty string when it carried none.
 * @param assembler - the finished assembler.
 * @returns concatenated text blocks.
 */
function assembledText(assembler: BlockAssembler): string {
  const blocks = assembler.blocks()
  return blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Translate a terminal finish reason into a failure message.
 * @param finish - the assembler's finish reason.
 * @returns the message, or undefined for a clean `stop`.
 */
function terminalFailure(finish: { readonly kind?: unknown; readonly failure?: { readonly message?: unknown } }): string | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'aborted':
    case 'error':
      return typeof finish.failure?.message === 'string' ? finish.failure.message : `classification ended with "${String(finish.kind)}"`
    case 'max-tokens':
      return 'classification output reached maxOutputTokens'
    case 'tool-calls':
      return 'classification model unexpectedly requested a tool'
    default:
      return `unsupported finish reason "${String(finish.kind)}"`
  }
}

/**
 * A caught value's message.
 * @param error - the caught value.
 * @returns its message, or its string form.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
