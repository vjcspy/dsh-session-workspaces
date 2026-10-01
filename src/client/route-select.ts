/**
 * The classification-route control's pure half.
 *
 * One compact single-line `<select>` replaces the `provider` and `model` text
 * fields that used to be separate. Its options are, in order:
 *
 * 1. **Auto** — `Auto — use the Session's own route` — which writes EMPTY
 *    `provider` and `model`. That is the default path: every Session classifies
 *    through its own logged route. Making a value mandatory here would put that
 *    path out of reach from the UI, so it stays the first option.
 * 2. every route the Host advertises, labelled `provider/model` with the
 *    technical tokens verbatim and no decoration;
 * 3. the route that is currently stored, when nothing advertises it, labelled
 *    `… (unavailable)` so the Human can still see what is configured instead of
 *    the control silently dropping it.
 *
 * A route is a PAIR. The control therefore carries ONE value for both fields:
 * the value is the encoded pair (`JSON.stringify([provider, model])`) and Auto is
 * the empty string, so "empty provider AND empty model" is one value rather than
 * two fields that could disagree, and a mismatched pair cannot be expressed at
 * all — the only values the select can hold are the ones in this list, and every
 * one of them is a whole pair.
 *
 * Why this lives outside the component: an external plugin's own gates have no
 * browser environment, so the union, the encoding and the write payload are unit
 * tested here and the component is only the wiring — which the real-browser proof
 * exercises.
 *
 * @module dsh-session-workspaces/client/route-select
 */

import type { CatalogRoute } from '../wire.ts'

/** The Auto option's value: the empty string, i.e. an empty `provider` and `model`. */
export const AUTO_ROUTE_VALUE = ''

/** One route: the pair both Config fields take. */
export interface RoutePair {
  /** Config `provider`. */
  readonly provider: string
  /** Config `model`. */
  readonly model: string
}

/** Which of the three kinds an option is. */
export type RouteOptionKind = 'auto' | 'advertised' | 'unavailable'

/** One `<select>` option. */
export interface RouteOption {
  /** The option's value: {@link AUTO_ROUTE_VALUE}, or an encoded pair. */
  readonly value: string
  /** The option's visible label. */
  readonly label: string
  /** The `provider` this option writes. */
  readonly provider: string
  /** The `model` this option writes. */
  readonly model: string
  /** `auto`, `advertised` or `unavailable`. */
  readonly kind: RouteOptionKind
}

/**
 * Encode one pair as a select value.
 *
 * A pair with nothing on either side is Auto — the same reading the Host's route
 * resolution applies, where a blank or half-filled pair is unconfigured.
 * @param provider - the pair's provider, verbatim.
 * @param model - the pair's model, verbatim.
 * @returns the empty string for the empty pair, otherwise a JSON pair.
 */
export function encodeRoute(provider: string, model: string): string {
  if (provider.trim() === '' && model.trim() === '') return AUTO_ROUTE_VALUE
  return JSON.stringify([provider, model])
}

/**
 * Decode one select value back to the pair it carries.
 * @param value - {@link AUTO_ROUTE_VALUE}, or a value {@link encodeRoute} produced.
 * @returns the pair; Auto for the empty value, and for a value this module could
 * not have produced (which is the same thing the empty pair writes).
 */
export function decodeRoute(value: string): RoutePair {
  if (value === AUTO_ROUTE_VALUE) return { provider: '', model: '' }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 2) return { provider: '', model: '' }
    const [provider, model] = parsed as readonly unknown[]
    if (typeof provider !== 'string' || typeof model !== 'string') return { provider: '', model: '' }
    return { provider, model }
  } catch {
    return { provider: '', model: '' }
  }
}

/**
 * Build the option list.
 *
 * The order is contractual: Auto first, then every advertised route in the order
 * the Host advertised it, then the stored route when nothing advertises it. A
 * route the Host advertises twice is offered once, and an advertisement that is
 * not a whole pair is not a route the control could write, so it is skipped.
 * @param input - the advertised catalog, the stored pair, and the two labels.
 * @returns the options, in select order.
 */
export function buildRouteOptions(input: {
  readonly advertised: readonly CatalogRoute[]
  readonly stored: RoutePair
  readonly autoLabel: string
  readonly unavailableLabel: (route: string) => string
}): readonly RouteOption[] {
  const options: RouteOption[] = [
    { value: AUTO_ROUTE_VALUE, label: input.autoLabel, provider: '', model: '', kind: 'auto' },
  ]
  const listed = new Set<string>([AUTO_ROUTE_VALUE])
  for (const route of input.advertised) {
    if (route.provider === '' || route.model === '') continue
    const value = encodeRoute(route.provider, route.model)
    if (listed.has(value)) continue
    listed.add(value)
    options.push({
      value,
      label: `${route.provider}/${route.model}`,
      provider: route.provider,
      model: route.model,
      kind: 'advertised',
    })
  }
  const stored = encodeRoute(input.stored.provider, input.stored.model)
  // A stored route nothing advertises stays visible — and therefore stays
  // savable — instead of being dropped while the catalog is missing or partial.
  if (!listed.has(stored)) {
    options.push({
      value: stored,
      label: input.unavailableLabel(`${input.stored.provider}/${input.stored.model}`),
      provider: input.stored.provider,
      model: input.stored.model,
      kind: 'unavailable',
    })
  }
  return options
}

/**
 * The two Config fields one select value writes.
 *
 * This is the single binding between the control and the write: the pair is read
 * back out of the option list, so the write can only ever carry a whole advertised
 * route — or, for the Auto option, two EMPTY strings.
 * @param options - the list the value came from.
 * @param value - the selected value.
 * @returns the pair, or `undefined` when the list does not carry that value (the
 * caller then writes nothing rather than guessing).
 */
export function routeFields(options: readonly RouteOption[], value: string): RoutePair | undefined {
  const option = options.find(candidate => candidate.value === value)
  if (option === undefined) return undefined
  return { provider: option.provider, model: option.model }
}
