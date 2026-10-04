/**
 * Copy dictionary for this plugin's browser half.
 *
 * Every product-visible string this plugin renders lives here and reaches a
 * component through the locale seat or the bound `copy` face; no component
 * carries literal copy.
 *
 * Workspace labels and group names are NOT here and must not be: they come from
 * the filesystem or from the Human and are rendered verbatim. An external plugin
 * does not run the harness's `verify-client-ui-i18n`, so this namespace is the
 * plugin's own bookkeeping rather than a harness gate — but the pattern is the
 * same one the shipped rows use.
 *
 * Only English ships. The locale service's lookup chain ends at `en` for every
 * active locale, so a composition running in another language still resolves
 * every key here rather than showing the key itself.
 *
 * @module dsh-session-workspaces/client/locales
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { LOCALE_NAMESPACE } from '../config.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-menu entries and the Settings section of this plugin. */
    dshSessionWorkspaces: DshSessionWorkspacesKey
  }
}

/** English dictionary, and the namespace's key-set source of truth. */
export const en = {
  'nav': 'Session workspaces',

  // Session row menu.
  'menu.moveWorkspace': 'Move to workspace…',
  'menu.moveGroup': 'Move to group…',
  'menu.newGroup': 'New group…',
  'menu.removeGroup': 'Remove from group',
  'menu.pickWorkspace': 'Choose a workspace',
  'menu.pickGroup': 'Choose a group',
  'menu.noGroups': 'No groups yet — create one from this menu.',
  'menu.groupName': 'Group name',
  'menu.createGroup': 'Create and move',
  'menu.cancel': 'Cancel',
  'menu.working': 'Working…',
  'menu.failed': 'The move failed: {message}',
  'menu.pinned': 'Pinned by you',

  // Settings section.
  'settings.heading': 'Session workspaces',
  'settings.intro': 'Group the sidebar Session list by Aweave workspace, decided by each conversation\'s first Human prompt.',
  'settings.enabled': 'Classify new Sessions',
  'settings.enabledHint': 'Off keeps every Session on the core Workspace grouping.',
  'settings.route': 'Classification route',
  'settings.routeAuto': 'Auto — use the Session\'s own route',
  'settings.routeUnavailable': '{route} (unavailable)',
  'settings.routeHint': 'One route for the whole feature. Auto writes an empty provider and model, so every Session classifies through its own logged route.',
  'settings.routeCatalogEmpty': 'The Host advertises no route right now. A configured route stays selected until you change it.',
  'settings.routeCatalogFailed': 'The route catalog could not be read: {message}',
  'settings.candidates': 'Additional candidate labels',
  'settings.candidatesHint': 'One per line, added to the directories discovered under the Aweave workspaces root.',
  'settings.discovered': 'Discovered workspaces: {list}',
  'settings.discoveredNone': 'No workspaces directory found yet.',
  'settings.unknownLabel': 'Unknown label',
  'settings.confidence': 'Minimum confidence',
  'settings.save': 'Save',
  'settings.saved': 'Saved',
  'settings.failed': 'The Host refused the write: {message}',
  'settings.unavailable': 'This deployment does not expose the plugin\'s configuration to the browser.',

  // Backfill. Every cost claim below is true by construction: a pass spends one
  // model call per Session whose log holds a human prompt, and `pending` is a
  // sample, so it is never stated as a bound.
  'backfill.heading': 'Classify existing Sessions',
  'backfill.explain': '{count} stored Session(s) are undecided (sampled). A pass reads each one and spends one model call only on those whose log holds a human prompt.',
  'backfill.start': 'Start a pass over {count} undecided Session(s)',
  'backfill.confirm': 'This reads {count} undecided Session(s) and spends at most one model call on each that has a human prompt. Continue?',
  'backfill.confirmYes': 'Yes, start',
  'backfill.confirmNo': 'Cancel',
  'backfill.none': 'Every stored Session is already decided.',
  'backfill.running': 'Running — {done} of {total} done, {classified} classified ({unknown} fell to the unknown group), {failed} failed, {noPrompt} with no human prompt.',
  'backfill.done': 'Last pass: {classified} classified ({unknown} fell to the unknown group), {skipped} skipped, {failed} failed, {noPrompt} with no human prompt.',
  'backfill.never': 'No pass has run yet.',
  'backfill.lastError': 'Last failure: {message}',
  'backfill.failures': 'Failures by reason: {read} unreadable log(s), {route} with no route, {timeout} timed out, {providerError} provider error(s), {malformed} malformed answer(s), {other} other.',
  'backfill.recentHeading': 'Recent failures',
  'backfill.recentRow': '{kind}: {message}',
} satisfies Record<string, string>

/** Every key this plugin's dictionary defines. */
export type DshSessionWorkspacesKey = keyof typeof en

/** The namespace-bound translate seat a component receives. */
export type SessionWorkspacesTranslate = PropsLocale<typeof LOCALE_NAMESPACE>['t']
