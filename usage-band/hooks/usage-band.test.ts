import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionRateLimit, TurnUsage } from 'claude-code'

import { CTX_COLORS, TERM_PALETTE, alt, cells, ctxLevel, formatCtxTokens, formatLeft, formatTokens, pillSvg, pillsOf, remainingFraction, termLayout, termPill } from './pills'
import type { Run } from './pills'

const H = 3_600_000
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 20.4, resetsAt: iso(NOW + 2 * H + 40 * 60_000) },
  { kind: 'seven_day', percentUsed: 58, resetsAt: iso(NOW + 31 * H) },
]
const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

function engine(on: On, rateLimits: SessionRateLimit[], usd?: number) {
  const clock = mock.clock(on, { now: NOW })
  const usage = { context: { window: 200_000 }, rateLimits, ...(usd === undefined ? {} : { cost: { usd } }) }
  on('session.usage', () => ({ value: { startedAt: NOW, ...usage } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: reply }
  })
  on('ui.render', () => ({ type: 'Box' }))
  return clock
}

// What the next model response (one turn.step) reports as its cost.
let reply: TurnUsage | null = null
const usageOf = (input: number, output: number, read: number, write: number): TurnUsage => ({
  model: 'claude-opus-5-5',
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})
async function respond($: Engine, turnId: string, index: number, usage: TurnUsage | null) {
  reply = usage
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream);
  return stream.result
}

const turn = (input: number, output: number, read: number, write: number) => ({
  answer: 'ok',
  durationMs: 1,
  isAborted: false,
  turnId: String(input),
  reason: 'answer' as const,
  usage: usageOf(input, output, read, write),
})

test('formats tokens', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(15_600)).toBe('15.6k')
  expect(formatTokens(954_200)).toBe('954.2k')
  expect(formatTokens(999_990)).toBe('1.0M')
  expect(formatTokens(1_200_000)).toBe('1.2M')
})

test('formats context tokens in whole thousands', () => {
  expect(formatCtxTokens(950)).toBe('950')
  expect(formatCtxTokens(42_000)).toBe('42k')
  expect(formatCtxTokens(210_400)).toBe('210k')
  expect(formatCtxTokens(1_000_000)).toBe('1.0M')
  expect(formatCtxTokens(999_600)).toBe('1.0M')
  expect(formatCtxTokens(999_400)).toBe('999k')
  expect(formatCtxTokens(1_234_567)).toBe('1.2M')
})

test('formats time left', () => {
  expect(formatLeft(2 * H + 40 * 60_000)).toBe('2h 40m')
  expect(formatLeft(31 * H)).toBe('1d 7h')
  expect(formatLeft(45 * 60_000)).toBe('45m')
  expect(formatLeft(-5)).toBe('0m')
})

test('tick is the share of time remaining in the window', () => {
  expect(Math.round(remainingFraction(LIMITS[0]!, NOW)! * 1000)).toBe(533)
  expect(Math.round(remainingFraction(LIMITS[1]!, NOW)! * 1000)).toBe(185)
  expect(remainingFraction({ kind: 'five_hour', percentUsed: 1 }, NOW)).toBe(null)
})

test('pills show the quota remaining, never below 0', () => {
  const [five, seven] = pillsOf([{ kind: 'five_hour', percentUsed: 7 }, { kind: 'seven_day', percentUsed: 104 }], null, null, NOW)
  expect(five).toMatchObject({ id: '5h', percent: 93 })
  expect(seven).toMatchObject({ id: '7d', percent: 0 })
  // the bar fill is the remaining share: 93% of 46 px
  expect(pillSvg(five!).source).toContain('width="42.78"')
})

test('pills with no data are left out', () => {
  expect(pillsOf([], null, null, NOW)).toEqual([])
  expect(pillsOf([], null, 1.5, NOW).map(p => p.id)).toEqual(['cost'])
  expect(pillsOf(LIMITS, null, null, NOW).map(p => p.id)).toEqual(['5h', '7d'])
  const p = pillsOf(LIMITS, null, null, NOW)[0]
  expect(p).toMatchObject({ id: '5h', percent: 80, left: '2h 40m' })
})

test('band passes when nothing has data, and yields to a survey', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
    await ui.unmount()
  }
})

test('token totals add up across two responses', async ($, on) => {
  engine(on, [])
  await respond($, 't1', 0, usageOf(1000, 500, 400_000, 2_600))
  await respond($, 't2', 0, usageOf(2000, 2500, 554_200, 10_000))
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const alts = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect(alts).toEqual(['Input tokens 15.6k', 'Output tokens 3.0k', 'Cache read 954.2k'])
})

test('token totals move after each response, before the turn ends', async ($, on) => {
  engine(on, [], 0.5)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const alts = async () => (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  await respond($, 't1', 0, usageOf(1000, 500, 400_000, 2_600))
  expect(await alts()).toEqual(['Input tokens 3.6k', 'Output tokens 500', 'Cache read 400.0k', 'Session cost $0.50'])
  await respond($, 't1', 1, usageOf(2000, 2500, 554_200, 10_000))
  expect(await alts()).toEqual(['Input tokens 15.6k', 'Output tokens 3.0k', 'Cache read 954.2k', 'Session cost $0.50'])
  // a response with no usage (interrupted, failed) adds nothing
  await respond($, 't1', 2, null)
  expect(await alts()).toContain('Input tokens 15.6k')
})

test("a turn's end adds nothing on top of its responses", async ($, on) => {
  engine(on, [])
  await respond($, 't1', 0, usageOf(1000, 500, 400_000, 2_600))
  await respond($, 't1', 1, usageOf(2000, 2500, 554_200, 10_000))
  await $.turn.complete({ ...turn(3000, 3000, 954_200, 12_600), turnId: 't1' })
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const alts = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect(alts).toEqual(['Input tokens 15.6k', 'Output tokens 3.0k', 'Cache read 954.2k'])
})

test('desktop tree holds the six pills in order, terminal the same figures', async ($, on) => {
  engine(on, LIMITS, 4.321)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await respond($, 't1', 0, usageOf(3000, 3000, 954_200, 12_600))

  const desk = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const svgs = await desk.findAll({ type: 'Svg' })
  expect(svgs.map(s => String(s.props.alt))).toEqual([
    '5-hour limit 80% left, resets in 2h 40m',
    '7-day limit 42% left, resets in 1d 7h',
    'Input tokens 15.6k',
    'Output tokens 3.0k',
    'Cache read 954.2k',
    'Session cost $4.32',
  ])
  expect(String(svgs[0]!.props.source)).toContain('monospace')
  expect(String(svgs[0]!.props.source)).toContain('<line')

  const term = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
  const text = (await term.drawn()) && (await term.findAll({ type: 'Text' })).map(t => t.text).join('')
  const order = ['5h', '80%', '2h 40m', '7d', '42%', '1d 7h', '15.6k', '3.0k', '954.2k', '$4.32']
  let at = -1
  for (const figure of order) {
    const next = text.indexOf(figure, at + 1)
    expect(next).toBeGreaterThan(at)
    at = next
  }
  expect(text).toContain('▎')
  expect(text).not.toContain('┃')
  expect(text).toContain('') // nerd glyphs by default
  // each pill, the cost one included, on its own tinted background
  for (const id of ['5h', '7d', 'in', 'out', 'cache', 'cost'] as const) {
    const pill = await term.find({ key: id })
    const bgs = (pill!.children as { props?: { backgroundColor?: string } }[]).map(c => c.props?.backgroundColor)
    expect(bgs).toContain(TERM_PALETTE.dark.pill[id].bg)
  }

  const survey = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await survey.findAll({ type: 'Svg' })).toHaveLength(0)
})

test('time left and tick refresh on the clock', async ($, on) => {
  const clock = engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  expect(String((await ui.findAll({ type: 'Svg' }))[0]!.props.alt)).toContain('2h 40m')
  await clock.advance(60_000)
  expect(String((await ui.findAll({ type: 'Svg' }))[0]!.props.alt)).toContain('2h 39m')
})

test('pills fit the reference strip width', () => {
  const pills = pillsOf(LIMITS, { input: 15_600, output: 3_000, cache: 954_200 }, 4.32, NOW)
  const total = pills.reduce((sum, p) => sum + pillSvg(p).width, 0)
  expect(total).toBeLessThanOrEqual(760)
})

test('no tick when the reset time is unknown', async ($, on) => {
  engine(on, [{ kind: 'five_hour', percentUsed: 20 }])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const desk = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const [svg] = await desk.findAll({ type: 'Svg' })
  expect(String(svg!.props.source)).not.toContain('fill="#333333"')
  const term = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
  const text = (await term.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(text).toContain('80%')
  expect(text).not.toContain('▎')
})

test('tokens reset when another session is resumed', async ($, on) => {
  engine(on, [])
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await respond($, 't1', 0, usageOf(1000, 500, 400_000, 2_600))
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's0' } })
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
})

test('context fill resets with the tokens on clear and resume, back on the next measure', async ($, on) => {
  engine(on, LIMITS, 4.32)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { window: 200_000, tokens: 82_000, percent: 41 }, rateLimits: LIMITS, cost: { usd: 4.32 }, changed: ['context'] })
  const first = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  expect((await first.findAll({ type: 'Svg' })).map(s => String(s.props.alt))).toContain('context 82k tokens (41% of window)')

  for (const reason of ['clear', 'resume'] as const) {
    await $.session.end({ reason, sessionId: 's1', resume: { id: 's0' } })
    const after = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
    const gone = (await after.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
    expect(gone.some(a => a.startsWith('context'))).toBe(false)

    await $.session.measure({ context: { window: 200_000, tokens: 124_000, percent: 62 }, rateLimits: LIMITS, cost: { usd: 4.32 }, changed: ['context'] })
    const back = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
    const shown = (await back.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
    expect(shown).toContain('context 124k tokens (62% of window)')
  }
})

test('other end reasons keep the context fill', async ($, on) => {
  engine(on, LIMITS, 4.32)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { window: 200_000, tokens: 82_000, percent: 41 }, rateLimits: LIMITS, cost: { usd: 4.32 }, changed: ['context'] })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's0' } })
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const alts = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect(alts).toContain('context 82k tokens (41% of window)')
})

test('a reload with no session.start still reads usage and keeps the clock', async ($, on) => {
  const clock = engine(on, LIMITS, 4.32)
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  await clock.advance(1)
  const first = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect(first[0]).toContain('2h 40m')
  expect(first[first.length - 1]).toBe('Session cost $4.32')
  await clock.advance(60_000)
  expect(String((await ui.findAll({ type: 'Svg' }))[0]!.props.alt)).toContain('2h 39m')
})

const FULL = pillsOf(LIMITS, { input: 15_600, output: 3_000, cache: 954_200 }, 4.32, NOW, { tokens: 210_400, window: 1_000_000 })
const ids = (row: { pills: { id: string }[] }) => row.pills.map(p => p.id)
const body = (row: { pills: { runs: { s: string }[] }[] }) => row.pills.map(p => p.runs.map(r => r.s).join('')).join(' ')

test('terminal ladder: full, no cache, short bars, compact labels, wrap', () => {
  for (const glyphs of ['nerd', 'unicode'] as const) {
    const at120 = termLayout(FULL, 120, glyphs, false)
    expect(at120).toMatchObject({ step: 1, width: 110, wrap: false, spacer: true })
    expect(ids(at120)).toEqual(['5h', '7d', 'in', 'out', 'cache', 'ctx', 'cost'])

    const at100 = termLayout(FULL, 100, glyphs, false)
    expect(at100).toMatchObject({ step: 2, width: 99, wrap: false, spacer: true })
    expect(ids(at100)).toEqual(['5h', '7d', 'in', 'out', 'ctx', 'cost'])

    const at94 = termLayout(FULL, 94, glyphs, false)
    expect(at94).toMatchObject({ step: 3, width: 94, wrap: false, spacer: false })
    expect(body(at94)).toContain('▏ ')

    // the user's terminal: one row, context and cost included
    const at86 = termLayout(FULL, 86, glyphs, false)
    expect(at86).toMatchObject({ step: 4, width: 86, wrap: false, spacer: false })
    expect(ids(at86)).toEqual(['5h', '7d', 'in', 'out', 'ctx', 'cost'])
    expect(body(at86)).toContain('2h40m')
    expect(body(at86)).toContain('1d7h')
    expect(body(at86)).toContain('210k')
    expect(body(at86)).not.toContain('▏')

    const at60 = termLayout(FULL, 60, glyphs, false)
    expect(at60).toMatchObject({ step: 5, wrap: true, spacer: false })
    expect(ids(at60)).toEqual(['5h', '7d', 'in', 'out', 'cache', 'ctx', 'cost'])
  }
})

test('the time tick is the block glyph on the cell background, in both glyph modes and palettes', () => {
  const tickPill = (percent: number) => ({ id: '5h' as const, percent, timeShare: 0.53, left: '' })
  for (const glyphs of ['nerd', 'unicode'] as const) {
    for (const light of [false, true]) {
      const pal = TERM_PALETTE[light ? 'light' : 'dark']
      for (const [pill, bg] of [[tickPill(80), pal.fill], [tickPill(10), pal.track]] as const) {
        const runs = termPill(pill, glyphs, light)
        const ticks = runs.filter(r => r.fg === pal.tick)
        expect(ticks).toHaveLength(1)
        expect(ticks[0]!).toMatchObject({ s: '▎', bg })
        expect(cells([ticks[0]!])).toBe(1)
        expect(runs.map(r => r.s).join('')).not.toContain('┃')
      }
    }
  }
})

test('no cell carrying a background colour draws a box-drawing glyph', () => {
  const boxDrawing = (s: string) => [...s].some(c => { const cp = c.codePointAt(0)!; return cp >= 0x2500 && cp <= 0x257f })
  for (const glyphs of ['nerd', 'unicode'] as const) {
    for (const light of [false, true]) {
      for (const step of [1, 2, 3, 4]) {
        const runs = FULL.reduce((all, p) => all.concat(termPill(p, glyphs, light, step)), [] as Run[])
        expect(runs.map(r => r.s).join('')).not.toContain('┃')
        for (const r of runs.filter(r => r.bg !== undefined)) expect(boxDrawing(r.s)).toBe(false)
      }
    }
  }
})

test('context pill: tokens kept, percent computed from tokens/window when absent, left out without tokens', () => {
  expect(pillsOf(LIMITS, null, 1, NOW).map(p => p.id)).toEqual(['5h', '7d', 'cost'])
  expect(pillsOf([], null, null, NOW, { tokens: 81_000, window: 200_000 })).toEqual([{ id: 'ctx', tokens: 81_000, percent: 41 }])
  expect(pillsOf([], null, null, NOW, { tokens: 80_800, window: 200_000, percent: 40.4 })).toEqual([{ id: 'ctx', tokens: 80_800, percent: 40 }])
  expect(pillsOf([], null, null, NOW, { tokens: 0, window: 200_000 })).toEqual([{ id: 'ctx', tokens: 0, percent: 0 }])
  expect(pillsOf([], null, null, NOW, { tokens: 0, window: 0 })).toEqual([{ id: 'ctx', tokens: 0, percent: 0 }])
  expect(pillsOf([], null, null, NOW, { tokens: 206_000, window: 200_000 })).toEqual([{ id: 'ctx', tokens: 206_000, percent: 100 }])
  expect(pillsOf([], null, null, NOW, null).map(p => p.id)).toEqual([])
  expect(FULL.map(p => p.id)).toEqual(['5h', '7d', 'in', 'out', 'cache', 'ctx', 'cost'])
  expect(alt(pillsOf([], null, null, NOW, { tokens: 210_400, window: 1_000_000 })[0]!)).toBe('context 210k tokens (21% of window)')
})

test('context colour steps at 60 and above 85, background included', () => {
  for (const [percent, level] of [[59, 'ok'], [60, 'warn'], [85, 'warn'], [86, 'high']] as const) {
    expect(ctxLevel(percent)).toBe(level)
    const [ctx] = pillsOf([], null, null, NOW, { tokens: percent * 2000, window: 200_000 })
    expect(pillSvg(ctx!).source).toContain(`fill="${CTX_COLORS[level].bg}"`)
    expect(pillSvg(ctx!).source).toContain(`fill="${CTX_COLORS[level].fg}"`)
    for (const light of [false, true]) {
      const pal = TERM_PALETTE[light ? 'light' : 'dark'].ctx[level]
      const runs = termPill(ctx!, 'nerd', light)
      expect(runs.some(r => r.bg === pal.bg)).toBe(true)
      expect(runs.some(r => r.fg === pal.fg)).toBe(true)
      expect(runs.map(r => r.s).join('')).toContain(formatCtxTokens(percent * 2000))
      expect(runs.some(r => r.fg === TERM_PALETTE[light ? 'light' : 'dark'].tick)).toBe(false)
    }
  }
  expect(TERM_PALETTE.dark.ctx.ok.fg).not.toBe(TERM_PALETTE.dark.pill['5h'].fg)
})

test('context pill follows session.measure only when context changed', async ($, on) => {
  engine(on, LIMITS, 4.32)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const desk = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const alts = async () => (await desk.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect((await alts()).some(a => a.startsWith('context'))).toBe(false)

  // a reading without tokens (a fresh window) shows no pill
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, cost: { usd: 4.32 }, changed: ['context'] })
  expect((await alts()).some(a => a.startsWith('context'))).toBe(false)

  await $.session.measure({ context: { window: 200_000, tokens: 82_000, percent: 41 }, rateLimits: LIMITS, cost: { usd: 4.32 }, changed: ['context'] })
  expect(await alts()).toEqual([
    '5-hour limit 80% left, resets in 2h 40m',
    '7-day limit 42% left, resets in 1d 7h',
    'context 82k tokens (41% of window)',
    'Session cost $4.32',
  ])
  const ctxSvg = (await desk.findAll({ type: 'Svg' })).find(s => String(s.props.alt).startsWith('context'))
  expect(String(ctxSvg!.props.source)).toContain('82k')
  expect(String(ctxSvg!.props.source)).not.toContain('41%')

  await $.session.measure({ context: { window: 200_000, tokens: 180_000, percent: 90 }, rateLimits: LIMITS, cost: { usd: 4.32 }, changed: ['rateLimits'] })
  expect(await alts()).toContain('context 82k tokens (41% of window)')

  await $.session.measure({ context: { window: 200_000, tokens: 180_000, percent: 90 }, rateLimits: LIMITS, cost: { usd: 4.32 }, changed: ['context'] })
  expect(await alts()).toContain('context 180k tokens (90% of window)')

  const term = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
  const ctx = await term.find({ key: 'ctx' })
  const bgs = (ctx!.children as { props?: { backgroundColor?: string } }[]).map(c => c.props?.backgroundColor)
  expect(bgs).toContain(TERM_PALETTE.dark.ctx.high.bg)
  expect((await term.findAll({ type: 'Text' })).map(t => t.text).join('')).toContain('180k')
})

test('token pills carry an icon and a figure, never a label', () => {
  for (const glyphs of ['nerd', 'unicode'] as const) {
    const row = termLayout(FULL, 120, glyphs, false)
    expect(row.wrap).toBe(false)
    expect(row.pills.map(p => p.id)).toEqual(['5h', '7d', 'in', 'out', 'cache', 'ctx', 'cost'])
    for (const id of ['in', 'out', 'cache'] as const) {
      const body = row.pills.find(p => p.id === id)!.runs.map(r => r.s).join('')
      expect(body).not.toContain('in')
      expect(body).not.toContain('out')
      expect(body).not.toContain('cache')
    }
  }
})

test('a light theme gets the light palette', async ($, on) => {
  engine(on, LIMITS, 4.32)
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'light', provider: { kind: 'engine' }, isLocked: false }] }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const term = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
  const cost = await term.find({ key: 'cost' })
  const bgs = (cost!.children as { props?: { backgroundColor?: string } }[]).map(c => c.props?.backgroundColor)
  expect(bgs).toContain(TERM_PALETTE.light.pill.cost.bg)
})

test('unicode glyphs when the option says so', { options: { glyphs: 'unicode' } }, async ($, on) => {
  engine(on, LIMITS, 4.32)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const term = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
  const text = (await term.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(text).toContain('$4.32')
  expect(text).toContain('▐')
  expect([...text].some(c => c.codePointAt(0)! >= 0xe000 && c.codePointAt(0)! <= 0xf8ff)).toBe(false)
  expect([...text].some(c => c.codePointAt(0)! > 0xffff)).toBe(false)
})

test('a refresh that rejects does not throw', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.usage', () => {
    throw new Error('engine shutting down')
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'Box' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
  await clock.advance(30_000)
  expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
})
