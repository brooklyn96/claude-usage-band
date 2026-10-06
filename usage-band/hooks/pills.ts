import type { ContextUsage, Limit, Tokens } from '../types'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WINDOWS = { five_hour: 5 * HOUR, seven_day: 7 * DAY } as const

/** `percent` is the quota remaining, `timeShare` the share of the window's time remaining. */
export type RatePill = { id: '5h' | '7d'; percent: number; timeShare: number | null; left: string }
export type ValuePill = { id: 'in' | 'out' | 'cache' | 'cost'; value: string }
/** `tokens` is the last response's input side; `percent` is the context window USED (what auto-compact reacts to), unlike the quota pills. */
export type ContextPill = { id: 'ctx'; tokens: number; percent: number }
export type Pill = RatePill | ValuePill | ContextPill

export const formatTokens = (n: number): string => {
  if (n < 1000) return String(Math.round(n))
  const k = Math.round(n / 100) / 10
  if (k < 1000) return `${k.toFixed(1)}k`
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`
}

/** Context pill only: whole thousands, no decimal (`950`, `42k`, `210k`); one decimal of millions from 1M up (`1.0M`, `1.2M`). */
export const formatCtxTokens = (n: number): string => {
  if (n < 1000) return String(Math.round(n))
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k`
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`
}

export const formatLeft = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / MIN))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** (resetsAt - now) / window, clamped to 0..1; null when the reset is unknown. */
export const remainingFraction = (limit: Limit, now: number): number | null => {
  const window = WINDOWS[limit.kind as keyof typeof WINDOWS]
  const resets = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
  if (!window || Number.isNaN(resets)) return null
  return Math.min(1, Math.max(0, (resets - now) / window))
}

export const pillsOf = (limits: Limit[], tokens: Tokens | null, cost: number | null, now: number, context: ContextUsage | null = null): Pill[] => {
  const pills: Pill[] = []
  for (const [kind, id] of [['five_hour', '5h'], ['seven_day', '7d']] as const) {
    const limit = limits.find(l => l.kind === kind)
    if (!limit) continue
    const left = limit.resetsAt === undefined ? '' : formatLeft(Date.parse(limit.resetsAt) - now)
    pills.push({ id, percent: Math.max(0, Math.round(100 - limit.percentUsed)), timeShare: remainingFraction(limit, now), left })
  }
  if (tokens) {
    pills.push({ id: 'in', value: formatTokens(tokens.input) })
    pills.push({ id: 'out', value: formatTokens(tokens.output) })
    pills.push({ id: 'cache', value: formatTokens(tokens.cache) })
  }
  if (context !== null) {
    const percent = context.percent ?? (context.window > 0 ? (context.tokens * 100) / context.window : 0)
    pills.push({ id: 'ctx', tokens: context.tokens, percent: Math.min(100, Math.max(0, Math.round(percent))) })
  }
  if (cost !== null) pills.push({ id: 'cost', value: `$${cost.toFixed(2)}` })
  return pills
}

export const isRate = (p: Pill): p is RatePill => p.id === '5h' || p.id === '7d'

/** Context fill step: below 60% calm, 60-85% amber, above 85% red. */
export const ctxLevel = (percent: number) => (percent > 85 ? 'high' : percent >= 60 ? 'warn' : 'ok')

// Colours sampled from the reference (light theme).
export const COLORS = {
  '5h': { bg: '#dce8e4', fg: '#3d8c7d' },
  '7d': { bg: '#e4e0f3', fg: '#7b5fd3' },
  in: { bg: '#f4ddd9', fg: '#d0553f' },
  out: { bg: '#dde9dc', fg: '#4c9a50' },
  cache: { bg: '#dfe2f7', fg: '#4a5bd6' },
  cost: { bg: '#f1ebd8', fg: '#c4952a' },
} as const
export const CTX_COLORS = {
  ok: { bg: '#d6eaee', fg: '#26879c' },
  warn: { bg: '#f7e3cb', fg: '#c46a12' },
  high: { bg: '#f6d5d8', fg: '#c62f3e' },
} as const
export const STRIP_BG = '#f1f0ec'
const INK = '#2b2b2b'
const MUTED = '#6f6f6f'
const FILL = '#8db36a'
const TRACK = '#d9d9d6'
const TICK = '#333333'
const DIVIDER = '#b9c2c0'

export const alt = (p: Pill): string => {
  if (isRate(p)) {
    const name = p.id === '5h' ? '5-hour' : '7-day'
    return `${name} limit ${p.percent}% left${p.left ? `, resets in ${p.left}` : ''}`
  }
  if (p.id === 'ctx') return `context ${formatCtxTokens(p.tokens)} tokens (${p.percent}% of window)`
  return { in: 'Input tokens', out: 'Output tokens', cache: 'Cache read', cost: 'Session cost' }[p.id] + ` ${p.value}`
}

// Icons: 24-unit stroke paths (Lucide-style), drawn at ICON px.
const ICONS = {
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  calendar:
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>' +
    '<text x="12" y="19.6" font-size="10" font-weight="700" text-anchor="middle" stroke="none" fill="currentColor">7</text>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  in: '<path d="M12 3v11M7 8l5-5 5 5"/><rect x="3" y="15" width="18" height="6" rx="2"/>',
  out: '<path d="M12 2v11M7 8l5 5 5-5"/><rect x="3" y="15" width="18" height="6" rx="2"/>',
  cache:
    '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/>' +
    '<path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  cost:
    '<circle cx="12" cy="12" r="10" fill="#f3d98a"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>',
  ctx:
    '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>' +
    '<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>' +
    '<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M12 5v13"/>',
} as const

// Sizes measured on the reference at 1x.
export const PILL_H = 22
const H = PILL_H
const FONT = 12.5
const CHAR = 7.5 // advance of a 12.5px monospace glyph (0.6em)
const ICON = 14
const BAR = 46
const CTX_BAR = 30
const FAMILY = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"

const icon = (name: keyof typeof ICONS, x: number, size: number, color: string) =>
  `<g transform="translate(${x} ${(H - size) / 2}) scale(${size / 24})" fill="none" stroke="${color}" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" color="${color}">${ICONS[name]}</g>`

const text = (s: string, x: number, color: string, bold = false) =>
  `<text x="${x}" y="${H / 2}" dominant-baseline="central" fill="${color}"${bold ? ' font-weight="700"' : ''}>${s}</text>`

/** One pill as an SVG document and its width in CSS pixels. */
export const pillSvg = (p: Pill): { source: string; width: number } => {
  const { bg, fg } = p.id === 'ctx' ? CTX_COLORS[ctxLevel(p.percent)] : COLORS[p.id]
  const parts: string[] = []
  let x = 9
  if (isRate(p)) {
    parts.push(icon(p.id === '5h' ? 'gauge' : 'calendar', x, ICON, fg))
    x += ICON + 7
    parts.push(text(p.id, x, MUTED))
    x += 2 * CHAR + 8
    const fill = (BAR * Math.min(100, Math.max(0, p.percent))) / 100
    const y = (H - 4) / 2
    parts.push(
      `<rect x="${x}" y="${y}" width="${BAR}" height="4" rx="2" fill="${TRACK}"/>`,
      `<rect x="${x}" y="${y}" width="${fill}" height="4" rx="2" fill="${FILL}"/>`,
    )
    if (p.timeShare !== null) {
      const tick = Math.min(BAR - 1, Math.max(1, BAR * p.timeShare))
      parts.push(`<rect x="${x + tick - 1}" y="${(H - 12) / 2}" width="2" height="12" rx="1" fill="${TICK}"/>`)
    }
    x += BAR + 8
    const pct = `${p.percent}%`
    parts.push(text(pct, x, INK, true))
    x += pct.length * CHAR + 9
    if (p.left) {
      parts.push(`<line x1="${x}" y1="${(H - 14) / 2}" x2="${x}" y2="${(H + 14) / 2}" stroke="${DIVIDER}" stroke-width="1"/>`)
      x += 9
      parts.push(icon('history', x, 13, fg))
      x += 13 + 6
      parts.push(text(p.left, x, MUTED))
      x += p.left.length * CHAR + 11
    } else x += 2
  } else if (p.id === 'ctx') {
    parts.push(icon('ctx', x, ICON, fg))
    x += ICON + 7
    const y = (H - 4) / 2
    parts.push(
      `<rect x="${x}" y="${y}" width="${CTX_BAR}" height="4" rx="2" fill="${TRACK}"/>`,
      `<rect x="${x}" y="${y}" width="${(CTX_BAR * p.percent) / 100}" height="4" rx="2" fill="${fg}"/>`,
    )
    x += CTX_BAR + 8
    const figure = formatCtxTokens(p.tokens)
    parts.push(text(figure, x, INK, true))
    x += figure.length * CHAR + 10
  } else {
    parts.push(icon(p.id, x, ICON, fg))
    x += ICON + 7.5
    parts.push(text(p.value, x, INK))
    x += p.value.length * CHAR + 10
  }
  const width = Math.ceil(x)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" ` +
    `font-family="${FAMILY}" font-size="${FONT}">` +
    `<rect width="${width}" height="${H}" rx="${H / 2}" fill="${bg}"/>${parts.join('')}</svg>`
  return { source, width }
}

// Terminal: each pill a row of coloured runs between two caps drawn in the pill colour.
export type Run = { s: string; fg?: string; bg?: string; bold?: boolean }
export type Glyphs = 'nerd' | 'unicode'

const GLYPHS = {
  // Nerd Font: powerline round caps, Material Design icons (each one cell).
  nerd: {
    caps: ['', ''],
    '5h': '\u{f029a}', // md-gauge
    '7d': '\u{f00ed}', // md-calendar
    left: '\u{f02da}', // md-history
    in: '\u{f011d}', // md-tray_arrow_up
    out: '\u{f0120}', // md-tray_arrow_down
    cache: '\u{f0328}', // md-layers
    cost: '', // fa-coins: md has no currency-usd circle
    ctx: '\u{f09d1}', // md-brain
  },
  // Only glyphs Cascadia Mono has, all single width.
  unicode: { caps: ['▐', '▌'], '5h': '◔', '7d': '▤', left: '◷', in: '↑', out: '↓', cache: '≡', cost: '◉', ctx: '◐' },
} as const

export const TERM_PALETTE = {
  dark: {
    pill: {
      '5h': { bg: '#1d3b36', fg: '#5ed0b8' },
      '7d': { bg: '#2d2850', fg: '#a892ff' },
      in: { bg: '#47231e', fg: '#ff7e66' },
      out: { bg: '#1f3d23', fg: '#72d37c' },
      cache: { bg: '#242c55', fg: '#8796ff' },
      cost: { bg: '#40331a', fg: '#f2c24e' },
    },
    ctx: {
      ok: { bg: '#14353d', fg: '#4cc3d9' },
      warn: { bg: '#48300f', fg: '#ff9f43' },
      high: { bg: '#4d1a22', fg: '#ff5c6c' },
    },
    text: '#ececea',
    muted: '#a9b1af',
    track: '#4a504e',
    fill: '#93d36d',
    tick: '#ffffff',
  },
  light: { pill: COLORS, ctx: CTX_COLORS, text: INK, muted: MUTED, track: '#c5c8c4', fill: FILL, tick: TICK },
} as const

const EIGHTHS = ' ▏▎▍▌▋▊▉█'

export const cells = (runs: Run[]): number => runs.reduce((n, r) => n + [...r.s].length, 0)

/**
 * One pill as runs, caps included, at ladder `step` (see termLayout): from step 3
 * the bars are shorter, from step 4 the time labels compact (`2h40m`, no divider).
 */
export const termPill = (p: Pill, glyphs: Glyphs, light: boolean, step = 1): Run[] => {
  const g = GLYPHS[glyphs]
  const pal = TERM_PALETTE[light ? 'light' : 'dark']
  const { bg, fg } = p.id === 'ctx' ? pal.ctx[ctxLevel(p.percent)] : pal.pill[p.id]
  const runs: Run[] = []
  const put = (s: string, color: string, extra: Partial<Run> = {}) => {
    const run = { s, fg: color, bg, ...extra }
    const last = runs[runs.length - 1]
    if (last && last.fg === run.fg && last.bg === run.bg && !!last.bold === !!run.bold) last.s += s
    else runs.push(run)
  }
  const bar = (percent: number, n: number, fill: string, tickAt = -1) => {
    const filled = Math.round((n * 8 * Math.min(100, percent)) / 100)
    for (let i = 0; i < n; i++) {
      const eighths = Math.min(8, Math.max(0, filled - 8 * i))
      if (i === tickAt) put('▎', pal.tick, { bg: eighths >= 4 ? fill : pal.track, bold: true })
      else put(EIGHTHS[eighths]!, fill, { bg: pal.track })
    }
  }
  runs.push({ s: g.caps[0], fg: bg })
  if (isRate(p)) {
    const n = step >= 3 ? 4 : 6
    put(`${g[p.id]} `, fg)
    put(`${p.id} `, pal.muted)
    bar(p.percent, n, pal.fill, p.timeShare === null ? -1 : Math.min(n - 1, Math.floor(p.timeShare * n)))
    put(' ', fg)
    put(`${p.percent}%`, pal.text, { bold: true })
    if (p.left && step >= 4) {
      put(` ${g.left}`, fg)
      put(p.left.replace(' ', ''), pal.muted)
    } else if (p.left) {
      put(' ▏ ', pal.muted)
      put(`${g.left} `, fg)
      put(p.left, pal.muted)
    }
  } else if (p.id === 'ctx') {
    put(`${g.ctx} `, fg)
    bar(p.percent, step >= 3 ? 3 : 4, fg)
    put(' ', fg)
    put(formatCtxTokens(p.tokens), pal.text, { bold: true })
  } else {
    put(`${g[p.id]} `, fg)
    put(p.value, pal.text)
  }
  runs.push({ s: g.caps[1], fg: bg })
  return runs
}

/**
 * The terminal row at `columns`, the first step that fits: 1 every pill;
 * 2 without the cache pill; 3 shorter bars (quota 6 -> 4 cells, context
 * 4 -> 3); 4 compact time labels; 5 every pill, wrapped. Width counts one gap
 * between pills; the cost pill's spacer (one more gap) shows only when it fits.
 */
export const termLayout = (pills: Pill[], columns: number, glyphs: Glyphs, light: boolean) => {
  const build = (step: number) => {
    const row = pills.filter(p => step < 2 || step > 4 || p.id !== 'cache').map(p => ({ id: p.id, runs: termPill(p, glyphs, light, step > 4 ? 1 : step) }))
    return { pills: row, width: row.reduce((n, p) => n + cells(p.runs) + 1, -1), step }
  }
  for (let step = 1; step <= 4; step++) {
    const row = build(step)
    if (row.width <= columns) return { ...row, wrap: false, spacer: row.pills.some(p => p.id === 'cost') && row.width + 1 <= columns }
  }
  return { ...build(5), wrap: true, spacer: false }
}
