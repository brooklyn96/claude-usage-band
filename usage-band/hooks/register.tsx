import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { Limit, Tokens } from '../types'
import { PILL_H, STRIP_BG, alt, isRate, pillSvg, pillsOf, termLayout } from './pills'
import type { Pill, ValuePill } from './pills'

const limitsAtom = atom({ plugin: 'usage-band', key: 'limits' } as const, [])
const costAtom = atom({ plugin: 'usage-band', key: 'cost' } as const, null)
const tokensAtom = atom({ plugin: 'usage-band', key: 'tokens' } as const, null)
// `tokens` shape: the value changed from a bare percent to the token reading.
const contextAtom = atom({ plugin: 'usage-band', key: 'context' } as const, null, { shape: 'tokens' })
const nowAtom = atom({ plugin: 'usage-band', key: 'now' } as const, 0)

/** `context` only when its fill moved (or on a full reading); `tokens` is absent before the first response. */
async function measured($: EngineInterface, rateLimits: readonly SessionRateLimit[], cost?: SessionCost, context?: SessionContextUsage) {
  const limits = rateLimits.map(({ kind, percentUsed, resetsAt }): Limit => (resetsAt ? { kind, percentUsed, resetsAt } : { kind, percentUsed }))
  await update($, limitsAtom, () => limits)
  await update($, costAtom, () => cost?.usd ?? null)
  if (context) {
    const next = context.tokens === undefined ? null : { tokens: context.tokens, window: context.window, percent: context.percent }
    await update($, contextAtom, () => next)
  }
}

async function spent($: EngineInterface, u: ModelUsage | null | undefined) {
  if (!u) return
  await update($, tokensAtom, (t): Tokens => ({
    input: (t?.input ?? 0) + u.input_tokens + u.cache_creation_input_tokens,
    output: (t?.output ?? 0) + u.output_tokens,
    cache: (t?.cache ?? 0) + u.cache_read_input_tokens,
  }))
}

async function refresh($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    await measured($, usage.rateLimits, usage.cost, usage.context)
    const now = await $.clock.now()
    await update($, nowAtom, () => now)
  } catch {
    // The engine is shutting down or a hook refused the reading: the next tick tries again.
  }
}

/** The /config theme row: `light`, `light-daltonized`, ... draw the light palette; anything else dark. */
const isLight = ($: EngineInterface) =>
  $.config.list().then(
    rows => String(rows.find(row => row.key === 'theme')?.value ?? '').startsWith('light'),
    () => false,
  )

// Timers die with the module, and a hot reload raises no session.start: whichever of
// session.start or the first draw comes first starts the clock for this module.
let started = false
function start($: EngineInterface) {
  if (started) return
  started = true
  $.clock.every(30_000, () => void refresh($))
}

export const register: Register = (on, options) => {
  const glyphs = options.glyphs === 'unicode' ? 'unicode' : 'nerd'

  on('session.start', async ($, e, next) => {
    await refresh($)
    start($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await measured($, e.rateLimits, e.cost, e.changed.includes('context') ? e.context : undefined)
    return next(e)
  })

  // Every priced response, main loop and subagents alike, as it comes back: the totals
  // move with the cost, not at the turn's end (turn.complete's usage is these summed).
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    await spent($, result.usage)
    return result
  })

  // The compaction summarizer is priced too, and raises no turn.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if ('usage' in result) await spent($, result.usage)
    return result
  })

  on('session.end', async ($, e, next) => {
    // Cost follows the new session's ledger on both, so the token totals and the
    // context fill start over too: the new session's first measure brings them back.
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, tokensAtom, () => null)
      await update($, contextAtom, () => null)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!started) {
      start($)
      $.clock.after(0, () => void refresh($)) // first reading after a reload; a draw never writes
    }
    if (e.props.hasSurvey) return next(e)
    await read($, nowAtom) // subscribes: the minute timer redraws the band
    const pills = pillsOf(
      await read($, limitsAtom),
      await read($, tokensAtom),
      await read($, costAtom),
      await $.clock.now(),
      await read($, contextAtom),
    )
    if (pills.length === 0) return next(e)

    const left = pills.filter(p => p.id !== 'cost')
    const cost = pills.find((p): p is ValuePill => p.id === 'cost')

    if (e.surface === 'desktop') {
      const { Box, Svg } = $.ui.resolve(e)
      const pill = (p: Pill) => {
        const { source, width } = pillSvg(p)
        return <Svg key={p.id} source={source} alt={alt(p)} width={width} height={PILL_H} />
      }
      return (
        <Box
          flexDirection="row"
          flexWrap="wrap"
          alignItems="center"
          backgroundColor={STRIP_BG}
          borderStyle="round"
          borderColor={STRIP_BG}
          paddingX={2}
          paddingY={1}
          columnGap={1}
          rowGap={1}
        >
          {left.filter(isRate).map(pill)}
          {left.some(isRate) && left.some(p => !isRate(p)) ? <Box width={1} /> : null}
          {left.filter(p => !isRate(p)).map(pill)}
          <Box flexGrow={1} />
          {cost ? pill(cost) : null}
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    const row = termLayout(pills, e.props.bodyColumns, glyphs, await isLight($))
    const pill = ({ id, runs }: (typeof row.pills)[number]) => (
      <Box key={id} flexDirection="row" flexShrink={0}>
        {runs.map((r, i) => (
          <Text key={String(i)} color={r.fg} backgroundColor={r.bg} bold={r.bold}>
            {r.s}
          </Text>
        ))}
      </Box>
    )
    const costPill = row.pills.find(p => p.id === 'cost')
    // Wrapped or a tight row, no spacer: the cost pill follows on whichever line has room.
    return (
      <Box flexDirection="row" flexWrap={row.wrap ? 'wrap' : 'nowrap'} columnGap={1} width={e.props.bodyColumns}>
        {row.pills.filter(p => p.id !== 'cost').map(pill)}
        {costPill && row.spacer ? <Box flexGrow={1} /> : null}
        {costPill ? pill(costPill) : null}
      </Box>
    )
  })
}
