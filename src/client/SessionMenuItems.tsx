/**
 * The four Session-row menu entries this plugin adds.
 *
 * Each is one entry of the existing `sidebar.workspaces.session.menu.item` list,
 * which is the only surface they need: the slot's owner share already carries the
 * row's `sessionId`, and the assignment is a plugin-owned record rather than a
 * Workspace mutation. No new core surface is involved.
 *
 * Each entry OWNS its chooser instead of raising a dialog: the menu is a live
 * DOM list whose keyboard walk reads its buttons, so the choices render inline
 * under the row that opened them. That keeps the whole interaction inside the
 * slot's own lifetime — the shipped `shell.overlay` route exists for dialogs that
 * outlive the menu, and none of these do.
 *
 * Every write goes through the fenced POST route, and the map each response
 * carries is folded straight into the store, so the tree moves on the same
 * response — no refresh, no second read.
 *
 * @module dsh-session-workspaces/client/SessionMenuItems
 */

import { useState, useSyncExternalStore, type CSSProperties } from 'react'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: declares the `sidebar.workspaces.session.menu.item` SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

import { LOCALE_NAMESPACE } from '../config.ts'
import type { MapState } from './state.ts'
import type { MutateRequest } from '../wire.ts'
import type { SessionWorkspacesTranslate } from './locales.ts'

/** The share every entry of this plugin receives. */
export interface SessionMenuInjected {
  /** The published map state. */
  readonly read: () => MapState
  /** Subscribe to map replacements. */
  readonly subscribe: (listener: () => void) => () => void
  /** Apply one write and fold the answered map into the store. */
  readonly mutate: (body: MutateRequest) => Promise<void>
  /**
   * Create one group and answer its id.
   *
   * Separate from {@link SessionMenuInjected.mutate} because the id lives in the
   * create response's own payload: the assignment that follows must name a group
   * that exists, so the two writes are ordered and only the second one is the
   * generic mutate.
   */
  readonly createGroup: (input: { readonly workspace: string; readonly name: string }) => Promise<string | undefined>
}

/** Full props of one entry: owner share + menu hooks + locale seat + this plugin's share. */
export type SessionMenuProps<Injected extends object = object> =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<typeof LOCALE_NAMESPACE>
  & InjectFace<Injected>

/** Inline presentation for the chooser a row expands into. */
const choices: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '4px 8px 6px 24px',
}

/** One inline chooser row. */
const choiceButton: CSSProperties = {
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 'inherit',
  padding: '3px 6px',
  borderRadius: 4,
}

/** The draft inputs inside the "new group" flow. */
const field: CSSProperties = {
  background: 'transparent',
  border: '1px solid currentColor',
  borderRadius: 4,
  color: 'inherit',
  fontSize: 'inherit',
  margin: '3px 0',
  padding: '3px 6px',
  width: '100%',
}

/** The muted line reporting a hint or an outcome. */
const note: CSSProperties = { opacity: 0.7, padding: '2px 6px' }

/** The shared behaviour of one entry: run a write, report a failure, dismiss the menu. */
function useWrite(setMenuOpen: (open: boolean) => void): {
    readonly busy: boolean
    readonly error: string | undefined
    readonly run: (action: () => Promise<void>) => Promise<void>
  } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      setMenuOpen(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

/** The published map, or undefined while the first read is in flight. */
function useMap(read: SessionMenuInjected['read'], subscribe: SessionMenuInjected['subscribe']) {
  return useSyncExternalStore(subscribe, read).map
}

/** What an entry renders while a write is in flight or has failed. */
function Status({ busy, error, t }: {
  readonly busy: boolean
  readonly error: string | undefined
  readonly t: SessionWorkspacesTranslate
}) {
  if (error !== undefined) return <div style={note}>{t('menu.failed', { message: error })}</div>
  if (busy) return <div style={note}>{t('menu.working')}</div>
  return null
}

/**
 * "Move to workspace…": pick one of the closed candidate labels.
 * @param props - owner share, menu hooks, locale seat and this plugin's share.
 * @returns the entry.
 */
export function MoveToWorkspaceItem({
  sessionId, useMenuOpenState, read, subscribe, mutate, t,
}: SessionMenuProps<SessionMenuInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const [open, setOpen] = useState(false)
  const map = useMap(read, subscribe)
  const write = useWrite(setMenuOpen)
  return (
    <>
      <MenuItemButton onSelect={() => { setOpen(current => !current) }}>
        {t('menu.moveWorkspace')}
      </MenuItemButton>
      {open && (
        <div style={choices}>
          <div style={note}>{t('menu.pickWorkspace')}</div>
          {(map?.candidates ?? []).map(candidate => (
            <button
              key={candidate}
              type="button"
              style={choiceButton}
              onClick={() => { void write.run(async () => { await mutate({ sessionId, workspace: candidate }) }) }}
            >
              {candidate}
            </button>
          ))}
          <Status busy={write.busy} error={write.error} t={t} />
        </div>
      )}
    </>
  )
}

/**
 * "Move to group…": pick a group. The group record carries its workspace, so
 * choosing a group owned by another workspace moves the Session's workspace too,
 * in the same write.
 * @param props - owner share, menu hooks, locale seat and this plugin's share.
 * @returns the entry.
 */
export function MoveToGroupItem({
  sessionId, useMenuOpenState, read, subscribe, mutate, t,
}: SessionMenuProps<SessionMenuInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const [open, setOpen] = useState(false)
  const map = useMap(read, subscribe)
  const write = useWrite(setMenuOpen)
  const groups = map?.groups ?? []
  return (
    <>
      <MenuItemButton onSelect={() => { setOpen(current => !current) }}>
        {t('menu.moveGroup')}
      </MenuItemButton>
      {open && (
        <div style={choices}>
          <div style={note}>{t('menu.pickGroup')}</div>
          {groups.length === 0 && <div style={note}>{t('menu.noGroups')}</div>}
          {groups.map(group => (
            <button
              key={group.id}
              type="button"
              style={choiceButton}
              onClick={() => {
                void write.run(async () => {
                  await mutate({ sessionId, workspace: group.workspace, group: group.id })
                })
              }}
            >
              {`${group.workspace} › ${group.name}`}
            </button>
          ))}
          <Status busy={write.busy} error={write.error} t={t} />
        </div>
      )}
    </>
  )
}

/**
 * "New group…": create a group inside a workspace and move the Session into it.
 *
 * Two writes, in order: the group must exist before the assignment can name it,
 * because the assignment resolves the group's workspace.
 * @param props - owner share, menu hooks, locale seat and this plugin's share.
 * @returns the entry.
 */
export function NewGroupItem({
  sessionId, useMenuOpenState, read, subscribe, mutate, createGroup, t,
}: SessionMenuProps<SessionMenuInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [name, setName] = useState('')
  const map = useMap(read, subscribe)
  const write = useWrite(setMenuOpen)
  const target = chosen ?? map?.sessions[sessionId]?.workspace
  const candidates = map?.candidates ?? []
  return (
    <>
      <MenuItemButton onSelect={() => { setOpen(current => !current) }}>
        {t('menu.newGroup')}
      </MenuItemButton>
      {open && (
        <div style={choices}>
          <div style={note}>{target ?? t('menu.pickWorkspace')}</div>
          {target === undefined && candidates.map(candidate => (
            <button
              key={candidate}
              type="button"
              style={choiceButton}
              onClick={() => { setChosen(candidate) }}
            >
              {candidate}
            </button>
          ))}
          {target !== undefined && (
            <>
              <input
                style={field}
                aria-label={t('menu.groupName')}
                placeholder={t('menu.groupName')}
                value={name}
                onChange={(event) => { setName(event.target.value) }}
              />
              <button
                type="button"
                style={choiceButton}
                onClick={() => {
                  const trimmed = name.trim()
                  if (trimmed === '') return
                  void write.run(async () => {
                    const group = await createGroup({ workspace: target, name: trimmed })
                    if (group === undefined) throw new Error('the group was not created')
                    await mutate({ sessionId, workspace: target, group })
                  })
                }}
              >
                {t('menu.createGroup')}
              </button>
            </>
          )}
          <Status busy={write.busy} error={write.error} t={t} />
        </div>
      )}
    </>
  )
}

/**
 * "Remove from group": return the Session to its workspace level, keeping it
 * pinned so nothing re-decides it. Renders nothing at all while the Session sits
 * at workspace level already.
 * @param props - owner share, menu hooks, locale seat and this plugin's share.
 * @returns the entry, or none.
 */
export function RemoveFromGroupItem({
  sessionId, useMenuOpenState, read, subscribe, mutate, t,
}: SessionMenuProps<SessionMenuInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const map = useMap(read, subscribe)
  const write = useWrite(setMenuOpen)
  const placed = map?.sessions[sessionId]
  if (placed === undefined || placed.group === undefined) return null
  const workspace = placed.workspace
  return (
    <>
      <MenuItemButton onSelect={() => {
        void write.run(async () => {
          await mutate({ op: 'group.removeMember', sessionId, workspace })
        })
      }}>
        {t('menu.removeGroup')}
      </MenuItemButton>
      <Status busy={write.busy} error={write.error} t={t} />
    </>
  )
}
