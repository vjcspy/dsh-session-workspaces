/**
 * The ordering the defect lived in, driven through a REAL Session.
 *
 * `packages/core/agent-loop/src/agent.ts` appends the first `user/message` at
 * `:421` and only then calls `buildRequest` at `:425`, which appends the
 * `request/header` that carries the Session's route. So a brand-new Session has
 * NO logged route at the instant its first prompt is committed, and any work
 * armed at that instant is armed without one.
 *
 * The stub harness cannot see that: it fakes the projection and calls the
 * plugin's listener directly. This spec mounts the BUILT artifact on a real
 * Cordis context holding the REAL `SessionStore` and the REAL
 * `SessionProjectionRegistry`, and drives real `session.append` calls, so the
 * event ordering, the scope-filtered dispatch and the projection fold are all
 * the host's own.
 *
 * It also carries the regression for the defect itself: a first prompt that was
 * committed while the plugin's storage unit had not opened yet used to be lost
 * for that Session forever, because the work was armed at the prompt and the
 * arm could not be created. The route is resolved at the header now, so the
 * Session recovers on its next header.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { builtEntry } from './harness.ts'
import { FakeFacility } from '../support/fake-domain.ts'
import { MAP_PATH } from '../../src/config.ts'

/** One mounted composition. */
interface Mounted {
  readonly ctx: Context
  readonly facility: FakeFacility
  readonly calls: GenerateOptions[]
  /** Every route the plugin registered on the fenced channel. */
  readonly routes: { readonly path: string; fetch(request: Request): Promise<Response> }[]
  /** Open the storage unit, for the specs that hold it closed on purpose. */
  readonly openStore: () => void
  readonly cwd: string
  dispose(): Promise<void>
}

/** Compositions mounted by the current spec, torn down afterwards. */
const mounted: Mounted[] = []

/** Monotonic message ids; the payload requires a unique id per message. */
let promptCounter = 0

/**
 * Mount the built artifact on a real context with a real Session store.
 * @param options - the plugin's Config row, and whether the storage unit opens at once.
 * @returns the mounted composition.
 */
async function mount(options: { readonly provider?: string; readonly model?: string; readonly deferStore?: boolean } = {}): Promise<Mounted> {
  const ctx = new Context()
  const facility = new FakeFacility()
  const calls: GenerateOptions[] = []
  const routes: { readonly path: string; fetch(request: Request): Promise<Response> }[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const root = await mkdtemp(join(tmpdir(), 'sws-route-'))
  const cwd = join(root, 'aweave')
  for (const label of ['k', 'tinybots', 'whill']) await mkdir(join(cwd, 'workspaces', label), { recursive: true })

  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('storageDomain', {
    open: async (spec: unknown) => {
      if (options.deferStore === true) await gate
      return await facility.open(spec as never)
    },
  })
  ctx.provide('llm', {
    stream: (received: GenerateOptions): AsyncIterable<StreamChunk> => {
      calls.push(received)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '{"label":"k","confidence":0.9}' } as StreamChunk
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      })()
    },
  })
  ctx.provide('sessionQuery', {
    listSessions: async () => [{ header: { id: 'seed', cwd } }],
    readSession: async () => ({ events: [] }),
  })
  ctx.provide('connection', {
    fetch: {
      register: (route: { readonly path: string; fetch(request: Request): Promise<Response> }) => {
        routes.push(route)
        return async () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
  })

  // The BUILT artifact, mounted with its own `inject` list so the real
  // scope-filtered `session/event` dispatch is what reaches it.
  const built: unknown = await import(pathToFileURL(builtEntry).href)
  await ctx.plugin(built as never, {
    ...options.provider === undefined ? {} : { provider: options.provider },
    ...options.model === undefined ? {} : { model: options.model },
  } as never)
  const composition: Mounted = {
    ctx,
    facility,
    calls,
    routes,
    openStore: () => { release?.() },
    cwd,
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
  mounted.push(composition)
  return composition
}

afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()?.dispose()
})

/** Wait until the plugin has opened its storage unit. */
async function storeOpen(composition: Mounted): Promise<void> {
  for (let attempt = 0; attempt < 400 && composition.facility.domain === undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  if (composition.facility.domain === undefined) throw new Error('the plugin never opened its storage unit')
}

/** Let the plugin's async work settle. */
async function settle(ms = 40): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** The label the plugin recorded for a Session, if any. */
function labelOf(composition: Mounted, sessionId: string): string | undefined {
  return composition.facility.domain?.labels.get(sessionId)?.workspace
}

/**
 * Commit one human prompt the way the agent loop does.
 * @param session - the live Session.
 * @param text - the prompt.
 * @returns the seq the prompt was committed at.
 */
function appendPrompt(session: Session, text: string): number {
  return session.append('user/message', {
    id: `msg-${String(promptCounter += 1)}`,
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  } as never, { surfaceOp: 'append' }).seq
}

/**
 * Commit the `request/header` the same turn appends.
 * @param session - the live Session.
 * @param provider - the route's provider.
 * @param model - the route's model.
 */
function appendHeader(session: Session, provider: string, model: string): void {
  session.append('request/header', {
    header: { config: { provider, model } },
    reason: 'initial',
  } as never)
}

describe('route ordering through a real Session', () => {
  it('records nothing while only the prompt exists, then classifies from the Session\'s own logged route', async () => {
    const composition = await mount()
    await storeOpen(composition)
    const seen: string[] = []
    composition.ctx.on('session/event', (_session, event) => { seen.push(event.type) })
    const session = composition.ctx.sessions.create(undefined, { meta: { cwd: composition.cwd } })

    // The prompt first: at this instant the Session has no logged route, which
    // is exactly the ordering agent.ts produces.
    appendPrompt(session, 'K workspace: fix the sidebar grouping bug under workspaces/k/dsh')
    await settle()
    expect(composition.calls).toHaveLength(0)
    expect(labelOf(composition, 'session-1')).toBeUndefined()

    appendHeader(session, 'opencode-go', 'muse-spark-1.3-contributor')
    await settle()
    expect(composition.calls).toHaveLength(1)
    expect(composition.calls[0]?.provider).toBe('opencode-go')
    expect(labelOf(composition, 'session-1')).toBe('k')

    // The call is invisible: no sessionId, no purpose, and the Session's own
    // event stream carries only the two events this spec appended.
    expect('sessionId' in (composition.calls[0] as object)).toBe(false)
    expect('purpose' in (composition.calls[0] as object)).toBe(false)
    expect(seen).toEqual(['user/message', 'request/header'])
  })

  it('records nothing and makes no call when no request header ever arrives', async () => {
    const composition = await mount()
    await storeOpen(composition)
    const session = composition.ctx.sessions.create(undefined, { meta: { cwd: composition.cwd } })
    appendPrompt(session, 'K workspace: fix the sidebar grouping bug under workspaces/k/dsh')
    await settle(80)
    expect(composition.calls).toHaveLength(0)
    expect(labelOf(composition, 'session-1')).toBeUndefined()
  })

  it('still classifies when the first prompt was committed before the storage unit opened', async () => {
    const composition = await mount({ deferStore: true })
    const session = composition.ctx.sessions.create(undefined, { meta: { cwd: composition.cwd } })
    // The whole first turn lands while this plugin cannot act: no store yet.
    appendPrompt(session, 'Tinybots: fix the login redirect bug under workspaces/tinybots')
    appendHeader(session, 'opencode-go', 'muse-spark-1.3-contributor')
    await settle()
    expect(composition.calls).toHaveLength(0)
    expect(labelOf(composition, 'session-1')).toBeUndefined()

    composition.openStore()
    await storeOpen(composition)
    // The next header — any later turn commits several — resolves the route
    // that exists NOW and classifies the first prompt from the projection.
    appendHeader(session, 'opencode-go', 'muse-spark-1.3-contributor')
    await settle()
    expect(composition.calls).toHaveLength(1)
    expect(labelOf(composition, 'session-1')).toBe('k')
  })

  it('lets an explicit Config route win over the Session\'s own logged route', async () => {
    const composition = await mount({ provider: 'cfg-p', model: 'cfg-m' })
    await storeOpen(composition)
    const session = composition.ctx.sessions.create(undefined, { meta: { cwd: composition.cwd } })
    appendPrompt(session, 'anything at all')
    appendHeader(session, 'session-p', 'session-m')
    await settle()
    expect(composition.calls).toHaveLength(1)
    expect(composition.calls[0]?.provider).toBe('cfg-p')
    expect(composition.calls[0]?.model).toBe('cfg-m')
  })

  it('never re-classifies a pinned Session', async () => {
    const composition = await mount()
    await storeOpen(composition)
    const domain = composition.facility.domain
    expect(domain).toBeDefined()
    await domain?.pins.put('session-1', { workspace: 'tinybots', pinnedAt: '2026-10-01T00:00:00.000Z' })
    const session = composition.ctx.sessions.create(undefined, { meta: { cwd: composition.cwd } })
    appendPrompt(session, 'K workspace: fix the sidebar grouping bug under workspaces/k/dsh')
    appendHeader(session, 'opencode-go', 'muse-spark-1.3-contributor')
    await settle()
    expect(composition.calls).toHaveLength(0)
    expect(labelOf(composition, 'session-1')).toBeUndefined()
  })

  it('publishes the label on the fenced map route', async () => {
    const composition = await mount()
    await storeOpen(composition)
    const session = composition.ctx.sessions.create(undefined, { meta: { cwd: composition.cwd } })
    appendPrompt(session, 'K workspace: fix the sidebar grouping bug under workspaces/k/dsh')
    appendHeader(session, 'opencode-go', 'muse-spark-1.3-contributor')
    await settle()
    const route = composition.routes.find(candidate => candidate.path === MAP_PATH)
    expect(route).toBeDefined()
    const response = await route?.fetch(new Request(`http://127.0.0.1${MAP_PATH}`, { method: 'GET' }))
    const payload = await response?.json() as { data: { sessions: Record<string, { workspace: string; pinned: boolean }> } }
    expect(payload.data.sessions['session-1']).toEqual({ workspace: 'k', pinned: false })
  })
})
