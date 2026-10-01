/**
 * Host half: classify the first human prompt of a Session into an Aweave
 * workspace, store it durably, and publish it with the plugin's group records
 * over two admission-fenced `/api` routes.
 *
 * The cadence is `session-title`'s own, deliberately: the same
 * `session/event` stream, the same `source.kind === 'user'` filter, and the same
 * "first eligible message" condition, read from a session projection so a
 * restart cannot restart the count. What differs is the work it drives — one
 * hidden auxiliary call with no `sessionId` and nothing appended to the
 * conversation surface — and the fact that failure is silent: a provider error,
 * a deadline or an unparseable answer records nothing and leaves the Session,
 * its turn and the core title feature exactly as they were.
 *
 * The route is never invented. Config `provider`/`model` wins; otherwise the
 * Session's own logged route answers, which is why the call waits for the
 * `request/header` the first turn produces; otherwise there is no call at all.
 *
 * @module dsh-session-workspaces
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

import {
  DEFAULT_CONFIDENCE, DEFAULT_UNKNOWN_LABEL, FIRST_PROMPT_PROJECTION, PLUGIN_ID,
} from './config.ts'
import { Config as PluginConfigSchema } from './schema.ts'
import type { Config as PluginConfig } from './schema.ts'
import { Backfill, type StoredSessionRecord } from './host/backfill.ts'
import { CandidateResolver } from './host/candidates.ts'
import { classify, resolveRoute, routeFromHeader, type SessionRoute } from './host/classifier.ts'
import { sessionWorkspacesDomain } from './host/domain.ts'
import { registerFirstPromptProjection } from './host/projection.ts'
import { registerFencedRoutes, routeDeps } from './host/routes.ts'
import { humanPromptText, type LoggedEvent } from './host/session-log.ts'
import { attachDomain, WorkspaceStore } from './host/store.ts'

/** Cordis plugin name and bundle id. */
export const name = PLUGIN_ID

/**
 * Services this half requires.
 *
 * `sessions` and `sessionQuery` are both read: the first answers a live
 * Session's own route and working directory cheaply, the second is what lets the
 * backfill see Sessions that are not loaded.
 */
export const inject = ['storageDomain', 'llm', 'sessionProjections', 'sessionQuery', 'sessions', 'connection']

/** How often the stored-Session working directories are re-sampled. */
const WORKING_DIRECTORY_TTL_MS = 300_000

/** How long a Session waits for a `request/header` before it is dropped. */
const ROUTE_WAIT_MS = 300_000

/** The plugin entry schema (schemastery; see `schema.ts`). */
export const Config = PluginConfigSchema

/** One Session whose first prompt is known but whose route is not yet. */
interface PendingEntry {
  readonly session: Session
  readonly prompt: string
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Mount the host half.
 * @param ctx - Host context.
 * @param config - this plugin's entry configuration.
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  const resolver = new CandidateResolver()
  const pending = new Map<string, PendingEntry>()
  let storedWorkingDirectories: string[] = []
  let disposed = false
  let store: WorkspaceStore | undefined

  /** Live settings, read at the moment of use: every writable field is volatile. */
  const settings = (): {
    enabled: boolean
    provider: string
    model: string
    candidates: readonly string[]
    unknownLabel: string
    threshold: number
    workspacesRoot: string
  } => ({
    enabled: readVolatile(config.enabled, true),
    provider: readVolatile(config.provider, ''),
    model: readVolatile(config.model, ''),
    candidates: readVolatile(config.candidates, [] as readonly string[]),
    unknownLabel: readVolatile(config.unknownLabel, DEFAULT_UNKNOWN_LABEL),
    threshold: readVolatile(config.confidence, DEFAULT_CONFIDENCE),
    workspacesRoot: config.workspacesRoot ?? '',
  })

  /** The closed candidate set: discovered directories plus the configured list. */
  const candidateLabels = (): string[] => resolver.resolve({
    configuredRoot: settings().workspacesRoot,
    configured: settings().candidates,
    workingDirectories: workingDirectories(),
  })

  /** Live Sessions' working directories, plus the stored sample. */
  const workingDirectories = (): string[] => {
    const live = ctx.sessions.list().flatMap(session => session.header.cwd === undefined ? [] : [session.header.cwd])
    return [...new Set([...live, ...storedWorkingDirectories])]
  }

  registerFirstPromptProjection(ctx)

  // A settings write commits into the running volatile reference and emits this
  // event instead of remounting the plugin. Every read above already goes
  // through the live reference; what must be invalidated is the CACHED discovery
  // of the candidate set, which is derived from the configuration.
  ctx.on('loader/volatile-update', (paths) => {
    resolver.invalidate()
    ctx.logger.debug(`${PLUGIN_ID}: configuration updated (${paths.map(path => path.join('.')).join(', ')})`)
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'request/header') {
      // The route may have arrived after the first prompt: that is the moment
      // the session-route branch can answer, and `attempt` decides.
      void attempt(String(session.id))
      return
    }
    if (event.type !== 'user/message') return
    if (store === undefined) return
    if (!settings().enabled) return
    const sessionId = String(session.id)
    if (pending.has(sessionId)) return
    // A decision already exists, or a Human pinned it: never re-decide.
    if (store.isDecided(sessionId)) return
    // Subagent Sessions are children of the Session that spawned them; the
    // first-count condition is the same one `session-title` uses.
    if (session.header.parentSession !== undefined) return
    const prompt = humanPromptText(event.data)
    if (prompt === undefined) return
    const state = ctx.sessionProjections.stateOf(session, FIRST_PROMPT_PROJECTION)
    if (state === undefined || state.count !== 1) return
    const entry: PendingEntry = {
      session,
      prompt,
      timer: setTimeout(() => { pending.delete(sessionId) }, ROUTE_WAIT_MS),
    }
    entry.timer.unref?.()
    pending.set(sessionId, entry)
    void attempt(sessionId)
  })

  /**
   * Run the classification for one pending Session, if its route is known.
   * @param sessionId - the pending Session.
   */
  const attempt = async (sessionId: string): Promise<void> => {
    const entry = pending.get(sessionId)
    const current = store
    if (entry === undefined || current === undefined) return
    const live = settings()
    const route = resolveRoute(
      { provider: live.provider, model: live.model },
      routeOf(entry.session),
    )
    // No route yet: the entry stays armed while the first turn produces its
    // `request/header`. With no route ever, nothing is recorded.
    if (route.source === 'none') return
    pending.delete(sessionId)
    clearTimeout(entry.timer)
    try {
      const outcome = await classify({ stream: options => ctx.llm.stream(options) }, {
        provider: route.provider,
        model: route.model,
        prompt: entry.prompt,
        candidates: candidateLabels(),
        unknownLabel: live.unknownLabel,
        threshold: live.threshold,
      })
      if (!outcome.ok) {
        ctx.logger.debug(`${PLUGIN_ID}: ${sessionId} not classified (${outcome.reason}): ${outcome.message}`)
        return
      }
      const written = await current.recordLabel(sessionId, outcome.label, outcome.confidence)
      ctx.logger.debug(
        `${PLUGIN_ID}: ${sessionId} → ${outcome.label} (${String(outcome.confidence)}) via ${route.source}${written ? '' : ' — pinned, not written'}`,
      )
    } catch (error) {
      // The classification is an auxiliary nicety: it must never disturb the
      // Session, its turn, or the core title feature.
      ctx.logger.warn(`${PLUGIN_ID}: classification failed for ${sessionId}: ${messageOf(error)}`)
    }
  }

  const refreshWorkingDirectories = async (): Promise<void> => {
    try {
      const records = await ctx.sessionQuery.listSessions()
      storedWorkingDirectories = [...new Set(records.flatMap(record => record.header.cwd === undefined ? [] : [record.header.cwd]))]
      resolver.invalidate()
    } catch (error) {
      ctx.logger.debug(`${PLUGIN_ID}: could not sample stored working directories: ${messageOf(error)}`)
    }
  }

  const sampler = setInterval(() => { void refreshWorkingDirectories() }, WORKING_DIRECTORY_TTL_MS)
  sampler.unref?.()

  // ONE handle for the unit, opened here and released on dispose. A second open
  // of the same name is `already-open`, so the handle's lifetime is the plugin
  // fiber's, and a failed open degrades the plugin to "no store" instead of
  // taking the composition down with it.
  const opened = ctx.storageDomain.open(sessionWorkspacesDomain).then(async (domain) => {
    if (disposed) {
      await domain.close()
      return
    }
    const opened = new WorkspaceStore(attachDomain(domain))
    store = opened
    const backfill = new Backfill({
      store: opened,
      listSessions: async (signal) => await listStoredSessions(ctx, signal),
      readSession: async (sessionId) => await readStoredSession(ctx, sessionId),
      stream: options => ctx.llm.stream(options),
      settings: () => {
        const live = settings()
        return {
          provider: live.provider,
          model: live.model,
          candidates: candidateLabels(),
          unknownLabel: live.unknownLabel,
          threshold: live.threshold,
        }
      },
      log: message => { ctx.logger.debug(message) },
    })
    registerFencedRoutes(ctx, routeDeps({
      store: opened,
      backfill,
      candidates: candidateLabels,
      unknownLabel: () => settings().unknownLabel,
    }))
    void refreshWorkingDirectories()
  })
  void opened.catch((error: unknown) => {
    ctx.logger.error(`${PLUGIN_ID}: could not open the storage unit: ${messageOf(error)}`)
  })

  ctx.effect(() => () => {
    disposed = true
    clearInterval(sampler)
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
    const closing = store
    store = undefined
    if (closing !== undefined) void closing.close()
  }, `${PLUGIN_ID}: store handle`)
}

/** Read one volatile field, tolerating a plain value from a hand-built config. */
function readVolatile<T>(value: Volatile<T> | T | undefined, fallback: T): T {
  if (value === undefined) return fallback
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    // `get()` answers the recursively-readonly snapshot of the same value; the
    // refinement is type-level only, so the cast is the honest narrowing.
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

/** The Session's own logged route, from its live request header. */
function routeOf(session: Session): SessionRoute | undefined {
  return routeFromHeader(session.requestHeader())
}

/** Every stored Session, reduced to the facts the backfill reads. */
async function listStoredSessions(ctx: Context, signal?: AbortSignal): Promise<readonly StoredSessionRecord[]> {
  const records = await ctx.sessionQuery.listSessions(signal)
  return records.map(record => ({
    id: String(record.header.id),
    cwd: record.header.cwd,
    parent: record.header.parentSession,
  }))
}

/** One stored Session's event log, read without making it live. */
async function readStoredSession(ctx: Context, sessionId: string): Promise<{ readonly events: readonly LoggedEvent[] }> {
  const snapshot = await ctx.sessionQuery.readSession(sessionId as SessionId)
  return { events: snapshot.events as readonly LoggedEvent[] }
}

/**
 * A caught value's message.
 * @param error - the caught value.
 * @returns its message, or its string form.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
