/**
 * Browser half: register the grouping provider that puts the Aweave workspace
 * above the group, contribute the four Session-menu entries, and mount the
 * Settings section.
 *
 * The whole half is a POLL over two admission-fenced routes — there is no push
 * channel from a plugin's host half to the page — and one consequence of the
 * seam's design shapes it: the seam recomputes the tree when a provider is
 * registered, not when a provider's own data changes. So a map that changed
 * re-registers the provider, which moves the seam's revision and repaints the
 * tree once. That is what makes a classification land without a refresh.
 *
 * Every registration is an effect of this context, so a plugin unload removes the
 * provider, the poll and the surfaces with it.
 *
 * @module dsh-session-workspaces/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: declares the `locale` member this half reads.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: declares the `slots` member this half registers into.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the `settings.section` slot declaration and the `configForms` merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the SlotMap entry of the Session row menu this half fills.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

import { GROUPING_PROVIDER_ID, LOCALE_NAMESPACE, SETTINGS_NAMESPACE } from '../config.ts'
import {
  backfill as backfillRequest, createGroup as createGroupRequest, mutate as mutateRequest,
} from './api.ts'
import { en } from './locales.ts'
import { registerGroupingProvider, type GroupingSeam } from './provider.ts'
import {
  MoveToGroupItem, MoveToWorkspaceItem, NewGroupItem, RemoveFromGroupItem, type SessionMenuInjected,
} from './SessionMenuItems.tsx'
import { SessionWorkspacesSettings, type SettingsInjected, type SettingsView } from './SettingsSection.tsx'
import { startMapPolling } from './state.ts'
import type { BackfillStatus, MapPayload } from '../wire.ts'

/** Services this half reads; all three are shell-provided. */
export const inject = ['slots', 'locale', 'configForms', 'workspaceGrouping']

/** The plugin's namespace view: the resolved volatile fields plus what the page needs around them. */
interface SettingsValues {
  readonly enabled?: boolean
  readonly provider?: string
  readonly model?: string
  readonly candidates?: readonly string[]
  readonly unknownLabel?: string
  readonly confidence?: number
}

/** A namespace view with nothing read yet. */
const EMPTY_BACKFILL: BackfillStatus = {
  running: false, total: 0, pending: 0, done: 0, classified: 0, failed: 0, skipped: 0,
}

/**
 * Mount the browser half.
 * @param ctx - the browser-side plugin context.
 */
export function apply(ctx: ClientContext): void {
  const copy = ctx.locale.bind(LOCALE_NAMESPACE)
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, 'en', en), `${GROUPING_PROVIDER_ID}: dictionaries`)

  const polling = startMapPolling()
  ctx.effect(() => () => { polling.dispose() }, `${GROUPING_PROVIDER_ID}: map poll`)

  // The write faces: each folds the map its response carries into the store, so
  // the tree and the settings card move on the response itself.
  const menuFace = (): SessionMenuInjected => ({
    read: polling.store.read,
    subscribe: polling.store.subscribe,
    mutate: async (body) => { polling.store.accept(await mutateRequest(body)) },
    createGroup: async (input) => {
      const created = await createGroupRequest(input)
      polling.store.accept(created.map)
      return created.id
    },
  })

  // The grouping seam. A registered provider is called for every listed Session;
  // an undefined answer leaves that Session on the core Workspace grouping.
  const seam = ctx.get('workspaceGrouping') as GroupingSeam | undefined
  if (seam === undefined) {
    ctx.logger.warn(`${GROUPING_PROVIDER_ID}: the client grouping seam is not mounted; grouping stays core-only`)
  } else {
    ctx.effect(() => {
      const registration = registerGroupingProvider({
        seam,
        store: polling.store,
        providerId: GROUPING_PROVIDER_ID,
      })
      return () => { registration.dispose() }
    }, `${GROUPING_PROVIDER_ID}: grouping provider`)
  }

  for (const entry of [
    { id: 'move-workspace', order: 500, Component: MoveToWorkspaceItem },
    { id: 'move-group', order: 510, Component: MoveToGroupItem },
    { id: 'new-group', order: 520, Component: NewGroupItem },
    { id: 'remove-group', order: 530, Component: RemoveFromGroupItem },
  ]) {
    ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
      name: 'sidebar.workspaces.session.menu.item',
      // Package-namespaced: the shipped rows are `pin`, `rename`, `fork`,
      // `archive`, and an id collision would shadow one of them.
      id: `${GROUPING_PROVIDER_ID}.${entry.id}`,
      order: entry.order,
      locale: LOCALE_NAMESPACE,
      inject: menuFace,
    }, entry.Component)), `${GROUPING_PROVIDER_ID}: ${entry.id}`)
  }

  const form = ctx.configForms.get<SettingsValues>(SETTINGS_NAMESPACE)
  let cachedForm: unknown
  let cachedMap: MapPayload | undefined
  let cachedView: SettingsView | undefined
  let lastError: string | undefined
  const subscribers = new Set<() => void>()
  const notify = (): void => {
    cachedView = undefined
    for (const listener of [...subscribers]) listener()
  }
  const unsubscribeForm = form.subscribe(notify)
  const unsubscribeMap = polling.store.subscribe(notify)
  ctx.effect(() => () => {
    unsubscribeForm()
    unsubscribeMap()
    subscribers.clear()
  }, `${GROUPING_PROVIDER_ID}: settings mirror`)

  const read = (): SettingsView => {
    const snapshot = form.getSnapshot()
    const map = polling.store.payload()
    // `useSyncExternalStore` compares snapshots by identity on every render AND
    // after every subscription check, so an uncached projection would re-render
    // forever. Both sources document a stable reference until the next change,
    // which is exactly the cache key here.
    if (cachedView === undefined || snapshot !== cachedForm || map !== cachedMap) {
      cachedForm = snapshot
      cachedMap = map
      const value = snapshot.value ?? {}
      cachedView = {
        served: snapshot.status === 'ready',
        writable: snapshot.writable,
        revision: snapshot.revision,
        enabled: value.enabled ?? true,
        provider: value.provider ?? '',
        model: value.model ?? '',
        candidates: (value.candidates ?? []).join('\n'),
        unknownLabel: value.unknownLabel ?? 'unknown workspace',
        confidence: value.confidence ?? 0.5,
        discovered: map?.candidates ?? [],
        backfill: map?.backfill ?? EMPTY_BACKFILL,
        error: lastError,
      }
    }
    return cachedView
  }

  const settingsFace: SettingsInjected = {
    read,
    subscribe: (listener) => {
      subscribers.add(listener)
      return () => { subscribers.delete(listener) }
    },
    save: async (fields) => {
      lastError = undefined
      try {
        for (const [field, value] of Object.entries(fields)) {
          if (value === undefined) continue
          const accepted = await form.set(field, value)
          if (!accepted) throw new Error(`the Host did not accept "${field}"`)
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        notify()
        throw error
      }
    },
    startBackfill: async () => {
      lastError = undefined
      try {
        const started = await backfillRequest('start')
        polling.store.accept(started.map)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        notify()
        throw error
      }
    },
    copy,
  }

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: GROUPING_PROVIDER_ID,
    order: 60,
    label: () => copy('nav'),
    inject: (): SettingsInjected => settingsFace,
  }, SessionWorkspacesSettings)), `${GROUPING_PROVIDER_ID}: settings section`)
}
