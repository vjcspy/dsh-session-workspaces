/**
 * Host half: classify the first human prompt of a Session into an Aweave
 * workspace, store it durably, and publish it with the plugin's group records
 * over admission-fenced `/api` routes — plus the advertised route catalog the
 * settings control offers.
 *
 * The cadence is `session-title`'s own predicate — the `source.kind === 'user'`
 * filter and the "first eligible message" condition — but not its trigger. The
 * work runs when the Session's **`request/header`** is committed, because that
 * is the instant the Session's own route exists: `packages/core/agent-loop/src/agent.ts`
 * appends the first `user/message` at `:421` and only then calls `buildRequest`
 * at `:425`, which appends the header. Observing the prompt instead would find
 * no route at all for a brand-new Session, and a plugin that resolved the route
 * there — or that armed its work there and lost the arm to a storage handle
 * that had not opened yet — recorded nothing for that Session forever.
 *
 * So nothing is armed and nothing is waited for: the route, the prompt and the
 * eligibility are all read at the one instant the route exists. A Session that
 * never commits a `request/header` is a Session that never dispatched a
 * request, and it records nothing — which is the contract's "no route → no call
 * at all" branch, with no sleep and no timer between the two.
 *
 * What the call does is unchanged: one hidden auxiliary call with no
 * `sessionId` and nothing appended to the conversation surface, and silent
 * failure — a provider error, a deadline or an unparseable answer records
 * nothing and leaves the Session, its turn and the core title feature exactly
 * as they were.
 *
 * The call answers TWICE from that one answer: it returns the sidebar label and
 * a summary of at most five words, and the plugin's own `sessionTitle` provider
 * hands that summary to the core title service as the Conversation title. Both
 * readers go through ONE keyed decision (`./host/decision.ts`), so a Session
 * costs exactly one model call — which is the whole point of merging them.
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
import { RouteCatalog } from './host/catalog.ts'
import { routeFromHeader, type SessionRoute } from './host/classifier.ts'
import { DecisionLedger } from './host/decision.ts'
import { sessionWorkspacesDomain } from './host/domain.ts'
import { registerFirstPromptProjection } from './host/projection.ts'
import { registerCatalogRoute, registerFencedRoutes, routeDeps } from './host/routes.ts'
import type { LoggedEvent } from './host/session-log.ts'
import { attachDomain, WorkspaceStore } from './host/store.ts'
import { registerTitleProvider, type TitleProviderStatus } from './host/title-provider.ts'

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

/** The plugin entry schema (schemastery; see `schema.ts`). */
export const Config = PluginConfigSchema

/**
 * Mount the host half.
 * @param ctx - Host context.
 * @param config - this plugin's entry configuration.
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  const resolver = new CandidateResolver()
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

  // ONE decision per Session, shared by the event path below and the title
  // provider: if both ask, they await the SAME `ctx.llm.stream` call. The
  // per-Session failure guard that used to live here now lives inside it, so the
  // "one attempt per Session" rule holds on both paths.
  const ledger = new DecisionLedger({
    stream: options => ctx.llm.stream(options),
    store: () => store,
    settings: () => {
      const live = settings()
      return {
        enabled: live.enabled,
        provider: live.provider,
        model: live.model,
        candidates: candidateLabels(),
        unknownLabel: live.unknownLabel,
        threshold: live.threshold,
      }
    },
    promptOf: session => firstPromptOf(ctx, session),
    routeOf: session => routeOf(session),
    debug: message => { ctx.logger.debug(message) },
  })

  // Whether this plugin owns the Conversation title, read per map request. It
  // starts pessimistic and is set by the registration itself, so the field only
  // ever reports what was ACTUALLY registered — there is no separate probe.
  let titleProvider: TitleProviderStatus = 'unavailable'

  // Optional on purpose: this attaches a child plugin that waits for
  // `sessionTitle`, so the grouping half below never depends on the title
  // service being present, or on it mounting before this plugin.
  registerTitleProvider(ctx, ledger, (status) => { titleProvider = status })

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
    // The ONE trigger: the Session's own request header, which is where its
    // route is. `attempt` re-reads the prompt and every eligibility condition
    // from durable/derived state at this instant, so a Session whose first
    // prompt was committed while this plugin could not act on it (its storage
    // unit had not opened, or the feature was disabled) still classifies on the
    // next header instead of being lost.
    if (event.type !== 'request/header') return
    void attempt(session)
  })

  /**
   * Classify one Session's first prompt, if its route and prompt are both known.
   *
   * The ledger reports the outcome once, so a Session that commits several
   * headers per turn — `initial`/`change`/`series` — adds no model call and no
   * second line about the same decision.
   * @param session - the Session whose header was just committed.
   */
  const attempt = async (session: Session): Promise<void> => {
    const sessionId = String(session.id)
    try {
      await ledger.decide(session)
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

  // The advertised route catalog. It does NOT depend on the durable store, so it
  // registers at apply time: the settings control must be able to offer routes
  // even when the storage unit failed to open, and the route answers an empty
  // catalog WITH its reason rather than failing.
  const catalog = new RouteCatalog({
    listProviders: () => ctx.llm.listProviders(),
    listModels: async (provider) => await ctx.llm.listModels(provider),
  })
  registerCatalogRoute(ctx, catalog)

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
      titleProvider: () => titleProvider,
    }))
    void refreshWorkingDirectories()
  })
  void opened.catch((error: unknown) => {
    ctx.logger.error(`${PLUGIN_ID}: could not open the storage unit: ${messageOf(error)}`)
  })

  ctx.effect(() => () => {
    disposed = true
    clearInterval(sampler)
    ledger.clear()
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

/**
 * The Session's first human prompt, when exactly one is committed.
 *
 * Read from this plugin's own projection rather than captured in memory, so it
 * is the SAME fact a restart replays rather than a capture a reload would lose.
 * @param ctx - host context.
 * @param session - the Session to read.
 * @returns the prompt, or undefined when the Session is not on its first message.
 */
function firstPromptOf(ctx: Context, session: Session): string | undefined {
  const state = ctx.sessionProjections.stateOf(session, FIRST_PROMPT_PROJECTION)
  return state !== undefined && state.count === 1 && state.prompt !== null ? state.prompt : undefined
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
