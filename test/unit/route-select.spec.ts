/**
 * The route control's pure contract: the option union — Auto first, then every
 * advertised route, then a stored-but-unadvertised route as `(unavailable)` — the
 * EMPTY pair Auto writes (the regression guard for the default path), and the fact
 * that a mismatched provider/model pair cannot be expressed at all.
 */

import { describe, expect, it } from 'vitest'
import {
  AUTO_ROUTE_VALUE, buildRouteOptions, decodeRoute, encodeRoute, routeFields, type RouteOption,
} from '../../src/client/route-select.ts'

/** Two advertised providers, the first of them with two models. */
const ADVERTISED = [
  { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
  { provider: 'opencode-go', model: 'muse-spark-1.4' },
  { provider: 'deepseek-official', model: 'deepseek-flash' },
]

/** Build options with the two labels the component passes. */
function optionsFor(input: {
  readonly advertised?: readonly { readonly provider: string; readonly model: string }[]
  readonly stored?: { readonly provider: string; readonly model: string }
}): readonly RouteOption[] {
  return buildRouteOptions({
    advertised: input.advertised ?? [],
    stored: input.stored ?? { provider: '', model: '' },
    autoLabel: 'Auto — use the Session\'s own route',
    unavailableLabel: route => `${route} (unavailable)`,
  })
}

/** The option a value names. */
function optionOf(options: readonly RouteOption[], value: string): RouteOption {
  const option = options.find(candidate => candidate.value === value)
  if (option === undefined) throw new Error(`no option for ${value}`)
  return option
}

describe('the option union', () => {
  it('puts Auto first, then every advertised route in catalog order', () => {
    const options = optionsFor({ advertised: ADVERTISED })
    expect(options.map(option => option.label)).toEqual([
      'Auto — use the Session\'s own route',
      'opencode-go/muse-spark-1.3-contributor',
      'opencode-go/muse-spark-1.4',
      'deepseek-official/deepseek-flash',
    ])
    expect(options.map(option => option.kind)).toEqual(['auto', 'advertised', 'advertised', 'advertised'])
    expect(options[0]?.value).toBe(AUTO_ROUTE_VALUE)
  })

  it('renders a stored route nothing advertises as (unavailable), after the advertised ones', () => {
    const stored = { provider: 'retired-provider', model: 'retired-model' }
    const options = optionsFor({ advertised: ADVERTISED, stored })
    expect(options).toHaveLength(5)
    const last = options[options.length - 1]
    expect(last?.kind).toBe('unavailable')
    expect(last?.label).toBe('retired-provider/retired-model (unavailable)')
    expect(last?.value).toBe(encodeRoute(stored.provider, stored.model))
    // The stored pair is what the control is selected on, so a Save cannot drop it.
    expect(routeFields(options, last?.value ?? '')).toEqual(stored)
  })

  it('keeps an advertised stored route as the advertised option only, with no duplicate', () => {
    const stored = { provider: 'opencode-go', model: 'muse-spark-1.4' }
    const options = optionsFor({ advertised: ADVERTISED, stored })
    expect(options).toHaveLength(4)
    expect(options.filter(option => option.provider === stored.provider && option.model === stored.model)).toHaveLength(1)
    expect(options.some(option => option.kind === 'unavailable')).toBe(false)
  })

  it('offers a route the host advertises twice exactly once', () => {
    const options = optionsFor({ advertised: [ADVERTISED[0]!, ADVERTISED[0]!, ADVERTISED[1]!] })
    expect(options.filter(option => option.kind === 'advertised')).toHaveLength(2)
  })

  it('does not offer a route that is not a whole pair', () => {
    const options = optionsFor({
      advertised: [{ provider: 'opencode-go', model: '' }, { provider: '', model: 'm' }],
    })
    expect(options).toHaveLength(1)
    expect(options[0]?.kind).toBe('auto')
  })

  it('adds no unavailable option when nothing is configured', () => {
    const options = optionsFor({ advertised: ADVERTISED })
    expect(options).toHaveLength(4)
    expect(options.some(option => option.kind === 'unavailable')).toBe(false)
  })

  it('stays usable and keeps a stored route while the catalog is empty', () => {
    const stored = { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }
    const options = optionsFor({ advertised: [], stored })
    expect(options.map(option => option.kind)).toEqual(['auto', 'unavailable'])
    expect(routeFields(options, encodeRoute(stored.provider, stored.model))).toEqual(stored)
  })

  it('keeps a half-configured stored value visible instead of dropping it', () => {
    const stored = { provider: 'opencode-go', model: ' ' }
    const options = optionsFor({ advertised: ADVERTISED, stored })
    const last = options[options.length - 1]
    expect(last?.kind).toBe('unavailable')
    expect(routeFields(options, last?.value ?? '')).toEqual(stored)
  })
})

describe('what the control writes', () => {
  it('Auto writes EMPTY provider and model — the default-path regression guard', () => {
    const options = optionsFor({ advertised: ADVERTISED })
    expect(routeFields(options, AUTO_ROUTE_VALUE)).toEqual({ provider: '', model: '' })
    expect(decodeRoute(AUTO_ROUTE_VALUE)).toEqual({ provider: '', model: '' })
    // The empty pair IS Auto, so a control seeded from an unconfigured Host is
    // selected on the option that leaves the Session's own route in charge.
    expect(encodeRoute('', '')).toBe(AUTO_ROUTE_VALUE)
    expect(optionOf(options, AUTO_ROUTE_VALUE).kind).toBe('auto')
  })

  it('an advertised option writes exactly the pair it displays — a mismatch cannot be expressed', () => {
    const options = optionsFor({ advertised: ADVERTISED })
    for (const option of options) {
      expect(routeFields(options, option.value)).toEqual({ provider: option.provider, model: option.model })
    }
    // Every value in the list round-trips to its own pair.
    expect(options.map(option => encodeRoute(option.provider, option.model)))
      .toEqual(options.map(option => option.value))
  })

  it('changing the provider moves the model with it, and no stale model survives', () => {
    const options = optionsFor({ advertised: ADVERTISED })
    const first = optionOf(options, encodeRoute('opencode-go', 'muse-spark-1.3-contributor'))
    const other = optionOf(options, encodeRoute('deepseek-official', 'deepseek-flash'))
    expect(first.provider).not.toBe(other.provider)
    expect(routeFields(options, first.value)).toEqual({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' })
    // Selecting the other provider's route changes BOTH fields: no value in the
    // list pairs one provider with the other provider's model.
    expect(routeFields(options, other.value)).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(options.some(option => option.value === encodeRoute('deepseek-official', 'muse-spark-1.3-contributor')))
      .toBe(false)
    // A provider with several models offers one option per model, so the model half
    // follows the selected provider.
    expect(options.filter(option => option.provider === 'opencode-go').map(option => option.model))
      .toEqual(['muse-spark-1.3-contributor', 'muse-spark-1.4'])
  })

  it('writes nothing for a value the option list does not carry', () => {
    const options = optionsFor({ advertised: ADVERTISED })
    expect(routeFields(options, encodeRoute('ghost', 'ghost-model'))).toBeUndefined()
    expect(routeFields(options, 'not-a-value-this-module-encoded')).toBeUndefined()
  })

  it('decodes an unrecognised value to the empty pair rather than inventing a route', () => {
    expect(decodeRoute('{"nope":true}')).toEqual({ provider: '', model: '' })
    expect(decodeRoute('["p","m","extra"]')).toEqual({ provider: '', model: '' })
    expect(decodeRoute('["p",7]')).toEqual({ provider: '', model: '' })
  })

  it('names a pair by its two tokens, verbatim', () => {
    expect(encodeRoute('opencode-go', 'muse-spark-1.3-contributor'))
      .toBe('["opencode-go","muse-spark-1.3-contributor"]')
    expect(decodeRoute('["opencode-go","muse-spark-1.3-contributor"]'))
      .toEqual({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' })
    // A model id may contain a slash; the encoding keeps the pair unambiguous.
    expect(decodeRoute(encodeRoute('p', 'anthropic/claude'))).toEqual({ provider: 'p', model: 'anthropic/claude' })
    expect(encodeRoute('p', 'anthropic/claude')).not.toBe('p/anthropic/claude')
  })
})
