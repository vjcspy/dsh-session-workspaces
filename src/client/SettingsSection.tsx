/**
 * The plugin's `settings.section`: the classification route, the candidate set,
 * and the opt-in backfill.
 *
 * The route control is ONE compact, single-line `<select>` (see
 * `./route-select.ts`): Auto, which writes empty `provider`/`model` and is the
 * default path where a Session classifies through its own logged route; then every
 * route the Host advertises; then the stored route when nothing advertises it. Its
 * options come from the Host's fenced catalog route, so this half takes no
 * dependency on a core client service.
 *
 * Reads ride the settings shell's shared describe mirror (`ctx.configForms`), so
 * every field here is a VOLATILE field of the host `Config` — a non-volatile
 * field is refused by the settings write gate, and the page would render a
 * control that cannot be saved. Writes go through `ConfigForm.set`, which carries
 * the revision that was read; `replace` is never used, because a document rebuilt
 * from a redacted wire view would delete values the wire never returned.
 *
 * The backfill states its own cost before it starts: the button names the number
 * of model calls, and starting is a second, explicit confirmation. It is never
 * automatic.
 *
 * @module dsh-session-workspaces/client/SettingsSection
 */

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `settings.section` slot declaration and the `configForms` Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

import type { BackfillStatus, CatalogRoute } from '../wire.ts'
import type { SessionWorkspacesTranslate } from './locales.ts'
import { buildRouteOptions, decodeRoute, encodeRoute, routeFields } from './route-select.ts'

/** One namespace view as this card renders it. */
export interface SettingsView {
  /** Whether the host half exposes its namespace to this browser. */
  readonly served: boolean
  /** Whether the host document accepts writes. */
  readonly writable: boolean
  /** Namespace revision the last read saw; undefined before the first. */
  readonly revision: number | undefined
  /** Whether the classification pass runs at all. */
  readonly enabled: boolean
  /** Configured route provider, or empty. */
  readonly provider: string
  /** Configured route model, or empty. */
  readonly model: string
  /** Routes the Host advertises right now; empty when none is, or when the read failed. */
  readonly catalog: readonly CatalogRoute[]
  /** Why the catalog read failed, while that stands. */
  readonly catalogError: string | undefined
  /** Configured extra candidate labels, one per line. */
  readonly candidates: string
  /** Label recorded for an undecidable answer. */
  readonly unknownLabel: string
  /** Minimum accepted confidence. */
  readonly confidence: number
  /** Workspace directories the host discovered, for display only. */
  readonly discovered: readonly string[]
  /** Backfill progress and the undecided count. */
  readonly backfill: BackfillStatus
  /** The last write or read failure, while one stands. */
  readonly error: string | undefined
}

/** The share this card receives. */
export interface SettingsInjected {
  /** The current view. */
  readonly read: () => SettingsView
  /** Subscribe to view replacements. */
  readonly subscribe: (listener: () => void) => () => void
  /** Persist one or more volatile fields. */
  readonly save: (fields: Readonly<Record<string, unknown>>) => Promise<void>
  /** Start one backfill pass. */
  readonly startBackfill: () => Promise<void>
  /** The plugin's own copy. */
  readonly copy: SessionWorkspacesTranslate
}

/** Full props of the section. */
export type SettingsSectionProps<Injected extends object = object> =
  PropsRuntime<'settings.section'> & InjectFace<Injected>

/** Presentation only: this card lives inside the shell's page frame. */
const root: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }
const row: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const label: CSSProperties = { fontWeight: 600 }
const hint: CSSProperties = { opacity: 0.7, fontSize: '0.85em' }
const input: CSSProperties = {
  background: 'transparent',
  border: '1px solid currentColor',
  borderRadius: 4,
  color: 'inherit',
  font: 'inherit',
  padding: '4px 6px',
}
const textarea: CSSProperties = { ...input, minHeight: 72, resize: 'vertical' }
/** The route control: ONE compact, single-line select. */
const select: CSSProperties = { ...input, maxWidth: 'fit-content', minWidth: 220 }
const button: CSSProperties = { ...input, cursor: 'pointer', padding: '4px 10px', width: 'fit-content' }
const danger: CSSProperties = { color: 'inherit', opacity: 0.9 }

/**
 * The editable draft, kept separate from the read view so a selection does not
 * fight the mirror.
 *
 * `route` is the route control's own VALUE — one encoded pair, or the empty string
 * for Auto — rather than a provider and a model that could drift apart: a
 * mismatched pair is not representable here, and the two Config fields are read
 * back out of the option list when the draft is written.
 */
interface Draft {
  readonly enabled: boolean
  readonly route: string
  readonly candidates: string
  readonly unknownLabel: string
  readonly confidence: string
}

function draftOf(view: SettingsView): Draft {
  return {
    enabled: view.enabled,
    route: encodeRoute(view.provider, view.model),
    candidates: view.candidates,
    unknownLabel: view.unknownLabel,
    confidence: String(view.confidence),
  }
}

/**
 * The section.
 * @param props - the shell's runtime share and this plugin's face.
 * @returns the card.
 */
export function SessionWorkspacesSettings({
  read, subscribe, save, startBackfill, copy: t,
}: SettingsSectionProps<SettingsInjected>) {
  const view = useSyncExternalStore(subscribe, read)
  const [draft, setDraft] = useState<Draft>(() => draftOf(view))
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const key = `${String(view.revision)}:${String(view.served)}`
  // The mirror is the source of truth: a Host acceptance (or a refusal's
  // recovery read) replaces the revision, and the draft follows it then.
  useEffect(() => { setDraft(draftOf(view)) }, [key])

  const run = async (action: () => Promise<void>, done: string): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      await action()
      setNotice(done)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  // The options are built from the route the VIEW reports as stored, not from the
  // draft: a configured route that nothing advertises therefore stays in the list
  // — and stays selectable — for as long as it is the stored one.
  const options = buildRouteOptions({
    advertised: view.catalog,
    stored: { provider: view.provider, model: view.model },
    autoLabel: t('settings.routeAuto'),
    unavailableLabel: route => t('settings.routeUnavailable', { route }),
  })
  // The pair is read back out of the option list, so a write can only ever carry
  // a whole option: Auto writes two EMPTY strings — the default path — and every
  // other option writes exactly the pair it displays. `decodeRoute` is the
  // unreachable fallback for a value this list did not carry, and it decodes to
  // the same pair the option held.
  const selected = routeFields(options, draft.route) ?? decodeRoute(draft.route)
  const confidence = Number.parseFloat(draft.confidence)
  const patch: Record<string, unknown> = {
    enabled: draft.enabled,
    provider: selected.provider.trim(),
    model: selected.model.trim(),
    candidates: draft.candidates.split('\n').map(line => line.trim()).filter(line => line !== ''),
    unknownLabel: draft.unknownLabel.trim() === '' ? undefined : draft.unknownLabel.trim(),
    confidence: Number.isFinite(confidence) ? confidence : undefined,
  }

  return (
    <div style={root}>
      <div style={row}>
        <span style={label}>{t('settings.heading')}</span>
        <span style={hint}>{t('settings.intro')}</span>
      </div>
      {!view.served && <div style={hint}>{t('settings.unavailable')}</div>}

      <div style={row}>
        <label style={label} htmlFor="dsh-session-workspaces-enabled">
          <input
            id="dsh-session-workspaces-enabled"
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => { setDraft({ ...draft, enabled: event.target.checked }) }}
          />
          {` ${t('settings.enabled')}`}
        </label>
        <span style={hint}>{t('settings.enabledHint')}</span>
      </div>

      <div style={row}>
        <label style={label} htmlFor="dsh-session-workspaces-route">{t('settings.route')}</label>
        <select
          id="dsh-session-workspaces-route"
          style={select}
          aria-label={t('settings.route')}
          value={draft.route}
          onChange={(event) => {
            // A value this render's option list does not carry writes nothing, so
            // the control can only ever produce a whole route or Auto.
            const chosen = routeFields(options, event.target.value)
            if (chosen === undefined) return
            setDraft({ ...draft, route: encodeRoute(chosen.provider, chosen.model) })
          }}
        >
          {options.map(option => (
            <option key={option.kind === 'auto' ? 'auto' : option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span style={hint}>{t('settings.routeHint')}</span>
        {view.catalog.length === 0 && view.catalogError === undefined && (
          <span style={hint}>{t('settings.routeCatalogEmpty')}</span>
        )}
        {view.catalogError !== undefined && (
          <span style={hint}>{t('settings.routeCatalogFailed', { message: view.catalogError })}</span>
        )}
      </div>

      <div style={row}>
        <span style={label}>{t('settings.candidates')}</span>
        <textarea
          style={textarea}
          aria-label={t('settings.candidates')}
          value={draft.candidates}
          onChange={(event) => { setDraft({ ...draft, candidates: event.target.value }) }}
        />
        <span style={hint}>{t('settings.candidatesHint')}</span>
        <span style={hint}>
          {view.discovered.length === 0
            ? t('settings.discoveredNone')
            : t('settings.discovered', { list: view.discovered.join(', ') })}
        </span>
      </div>

      <div style={row}>
        <span style={label}>{t('settings.unknownLabel')}</span>
        <input
          style={input}
          aria-label={t('settings.unknownLabel')}
          value={draft.unknownLabel}
          onChange={(event) => { setDraft({ ...draft, unknownLabel: event.target.value }) }}
        />
      </div>

      <div style={row}>
        <span style={label}>{t('settings.confidence')}</span>
        <input
          style={input}
          aria-label={t('settings.confidence')}
          value={draft.confidence}
          onChange={(event) => { setDraft({ ...draft, confidence: event.target.value }) }}
        />
      </div>

      <button
        type="button"
        style={button}
        disabled={busy || !view.writable}
        onClick={() => { void run(async () => { await save(patch) }, t('settings.saved')) }}
      >
        {t('settings.save')}
      </button>

      <div style={{ ...row, borderTop: '1px solid currentColor', paddingTop: 8 }}>
        <span style={label}>{t('backfill.heading')}</span>
        <span style={hint}>{t('backfill.explain', { count: String(view.backfill.pending) })}</span>
        {view.backfill.running && (
          <span style={hint}>
            {t('backfill.running', {
              done: String(view.backfill.done),
              total: String(view.backfill.total),
              classified: String(view.backfill.classified),
              failed: String(view.backfill.failed),
            })}
          </span>
        )}
        {!view.backfill.running && view.backfill.finishedAt !== undefined && (
          <span style={hint}>
            {t('backfill.done', {
              classified: String(view.backfill.classified),
              skipped: String(view.backfill.skipped),
              failed: String(view.backfill.failed),
            })}
          </span>
        )}
        {!view.backfill.running && view.backfill.finishedAt === undefined && (
          <span style={hint}>{t('backfill.never')}</span>
        )}
        {view.backfill.lastError !== undefined && (
          <span style={{ ...hint, ...danger }}>{t('backfill.lastError', { message: view.backfill.lastError })}</span>
        )}
        {view.backfill.pending === 0 && !view.backfill.running
          ? <span style={hint}>{t('backfill.none')}</span>
          : !confirming
            ? (
              <button
                type="button"
                style={button}
                disabled={busy || view.backfill.running}
                onClick={() => { setConfirming(true) }}
              >
                {t('backfill.start', { count: String(view.backfill.pending) })}
              </button>
            )
            : (
              <div style={row}>
                <span style={hint}>{t('backfill.confirm', { count: String(view.backfill.pending) })}</span>
                <button
                  type="button"
                  style={button}
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false)
                    void run(async () => { await startBackfill() }, t('backfill.running', {
                      done: '0', total: String(view.backfill.pending), classified: '0', failed: '0',
                    }))
                  }}
                >
                  {t('backfill.confirmYes')}
                </button>
                <button type="button" style={button} onClick={() => { setConfirming(false) }}>
                  {t('backfill.confirmNo')}
                </button>
              </div>
            )}
      </div>

      {notice !== undefined && <div style={hint}>{notice}</div>}
      {view.error !== undefined && <div style={{ ...hint, ...danger }}>{t('settings.failed', { message: view.error })}</div>}
    </div>
  )
}
