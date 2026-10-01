/**
 * Composition harness: the BUILT plugin artifact mounted on a real Cordis
 * context through a real `cordis.yml` read by the real Loader, with the services
 * it injects provided as recording stubs.
 *
 * Two things are proven here that a source-only spec cannot: `lib/index.js` —
 * the file a profile install actually loads — is what runs, and the plugin
 * composes in the same shape `cordis.patch.yml` inserts into a profile.
 *
 * `session/event` is delivered through Cordis scope-filtered dispatch, which
 * needs a live Session carrier, so the listener is captured and called directly:
 * the subject under test is this plugin's own cadence, not the host's dispatch.
 *
 * @module dsh-session-workspaces/test/composition/harness
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { FakeFacility } from '../support/fake-domain.ts'
import type { RegisteredRoute } from '../support/fake-ctx.ts'

/** Repository root of this plugin package. */
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The artifact a profile install loads. */
export const builtEntry = join(packageRoot, 'lib', 'index.js')

/** One Session as the plugin's listener receives it. */
export interface StubSession {
  readonly id: string
  readonly header: { readonly cwd?: string | undefined; readonly parentSession?: unknown }
  /** The route the Session most recently dispatched on, when one was recorded. */
  route: { provider: string; model: string } | undefined
  /** Every append this plugin attempted; it must stay empty. */
  readonly appended: string[]
  requestHeader(): { config: { provider: string; model: string } } | undefined
  append(type: string): void
}

/** One Session event as the host dispatches it. */
export interface StubEvent {
  readonly type: string
  readonly data?: unknown
  readonly seq?: number
}

/** The booted composition. */
export interface Composition {
  /** The booted context. */
  readonly ctx: Context
  /** Every route the plugin registered on the fenced channel. */
  readonly routes: RegisteredRoute[]
  /** The storage facility the plugin opened through. */
  readonly facility: FakeFacility
  /** Every `llm.stream` call, in order. */
  readonly llmCalls: GenerateOptions[]
  /** Script the chunks the next call streams. */
  script(chunks: readonly StreamChunk[]): void
  /** Script a rejection for the next call. */
  scriptThrow(message: string): void
  /** Create one Session carrier. */
  session(id: string, overrides?: { readonly parent?: unknown; readonly cwd?: string | undefined }): StubSession
  /** Deliver one event to the plugin's own listener. */
  fire(session: StubSession, event: StubEvent): void
  /**
   * Deliver one COMPLETE first turn the way the host does: the prompt first,
   * then the `request/header` that carries its route (`agent.ts:421` then
   * `:425`). `route` sets the Session's logged route before the header lands.
   */
  turn(session: StubSession, text: string, route?: { readonly provider: string; readonly model: string }): void
  /** The projection state the plugin will read. */
  projection(state: { count: number; seq: number | null; prompt: string | null } | undefined): void
  /** Wait until the plugin has opened its storage unit. */
  ready(): Promise<void>
  /** Let pending microtasks and timers settle. */
  settle(ms?: number): Promise<void>
  /** Unmount everything. */
  dispose(): Promise<void>
}

/** Options for {@link boot}. */
export interface BootOptions {
  /** Provider/model written into the plugin's config row. */
  readonly provider?: string
  /** Model written into the plugin's config row. */
  readonly model?: string
  /** Mount the plugin row at all; default true. */
  readonly withPlugin?: boolean
}

/**
 * Boot the plugin through a real Loader over a generated `cordis.yml`.
 * @param options - the config row to write.
 * @returns the booted composition; the caller owns `dispose()`.
 */
export async function boot(options: BootOptions = {}): Promise<Composition> {
  if (!existsSync(builtEntry)) throw new Error(`built artifact missing: ${builtEntry} — run \`pnpm run build\` first`)
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-workspaces-'))
  const ctx = new Context()
  const routes: RegisteredRoute[] = []
  const llmCalls: GenerateOptions[] = []
  const facility = new FakeFacility()
  let scripted: readonly StreamChunk[] = [
    { type: 'text-delta', index: 0, text: '{"label":"k","confidence":0.9}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ] as readonly StreamChunk[]
  let scriptedThrow: string | undefined
  let projection: { count: number; seq: number | null; prompt: string | null } | undefined = {
    count: 1,
    seq: 1,
    prompt: 'work on the k repo',
  }
  const listeners: ((session: StubSession, event: StubEvent) => void)[] = []

  ctx.provide('storageDomain', {
    open: async (spec: unknown) => await facility.open(spec as never),
  })
  ctx.provide('llm', {
    stream: (received: GenerateOptions): AsyncIterable<StreamChunk> => {
      llmCalls.push(received)
      if (scriptedThrow !== undefined) {
        const message = scriptedThrow
        return (async function* (): AsyncIterable<StreamChunk> { throw new Error(message) })()
      }
      return (async function* () { for (const chunk of scripted) yield chunk })()
    },
    // The advertised route catalog the settings control reads.
    listProviders: () => [{ id: 'fixture-p' }],
    listModels: async (provider: string) => provider === 'fixture-p' ? [{ id: 'fixture-m' }] : [],
  })
  ctx.provide('sessionProjections', {
    register: () => () => {},
    stateOf: () => projection,
  })
  // A real workspace tree, because the candidate set is DISCOVERED rather than
  // configured: the plugin walks up from the working directories the corpus
  // reports and lists `<root>/workspaces/*`.
  const aweaveRoot = join(root, 'aweave')
  for (const name of ['k', 'tinybots', 'whill']) await mkdir(join(aweaveRoot, 'workspaces', name), { recursive: true })
  ctx.provide('sessionQuery', {
    listSessions: async () => [{ header: { id: 'seed', cwd: aweaveRoot } }],
    readSession: async () => ({ events: [] }),
  })
  ctx.provide('sessions', {
    list: () => [],
    get: () => undefined,
  })
  ctx.provide('connection', {
    fetch: {
      register: (route: RegisteredRoute) => {
        routes.push(route)
        return async () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
  })

  // Capture the plugin's own `session/event` listeners, as debate-bridge's
  // harness does: Cordis scope-filtered dispatch needs a live carrier.
  const host = ctx as unknown as { on(name: string, listener: (session: StubSession, event: StubEvent) => void): () => void }
  const originalOn = host.on.bind(ctx)
  host.on = (name, listener) => {
    if (name === 'session/event') listeners.push(listener)
    return originalOn(name, listener)
  }

  const built: unknown = await import(pathToFileURL(builtEntry).href)
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
  const Include = (await import('@deepseek-ai/cordis-plugin-include')).default
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    ...(options.withPlugin ?? true)
      ? [
        `- id: dsh-session-workspaces`,
        `  name: 'dsh-session-workspaces'`,
        ...options.provider === undefined && options.model === undefined
          ? []
          : [
            '  config:',
            ...options.provider === undefined ? [] : [`    provider: '${options.provider}'`],
            ...options.model === undefined ? [] : [`    model: '${options.model}'`],
          ],
      ]
      : [],
    '',
  ].join('\n'), 'utf8')

  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === 'dsh-session-workspaces') return built
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  const composition: Composition = {
    ctx,
    routes,
    facility,
    llmCalls,
    script: (chunks) => { scripted = chunks; scriptedThrow = undefined },
    scriptThrow: (message) => { scriptedThrow = message },
    session: (id, overrides = {}) => {
      const session: StubSession = {
        id,
        header: overrides.parent === undefined && overrides.cwd === undefined
          ? {}
          : { ...overrides.parent === undefined ? {} : { parentSession: overrides.parent }, ...overrides.cwd === undefined ? {} : { cwd: overrides.cwd } },
        route: undefined,
        appended: [],
        requestHeader: () => session.route === undefined
          ? undefined
          : { config: { provider: session.route.provider, model: session.route.model } },
        append: (type) => { session.appended.push(type) },
      }
      return session
    },
    fire: (session, event) => { for (const listener of listeners) listener(session, event) },
    turn: (session, text, route) => {
      composition.fire(session, humanMessage(text))
      if (route !== undefined) session.route = { provider: route.provider, model: route.model }
      composition.fire(session, requestHeader(session.route?.provider ?? '', session.route?.model ?? ''))
    },
    projection: (state) => { projection = state },
    ready: async () => {
      for (let attempt = 0; attempt < 200 && facility.domain === undefined; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      if (facility.domain === undefined) throw new Error('the plugin never opened its storage unit')
    },
    settle: async (ms = 20) => { await new Promise(resolve => setTimeout(resolve, ms)) },
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
  return composition
}

/** One human prompt event. */
export function humanMessage(text: string, seq = 1): StubEvent {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] }, seq }
}

/** One request-header event carrying a route. */
export function requestHeader(provider: string, model: string): StubEvent {
  return { type: 'request/header', data: { header: { config: { provider, model } } } }
}
