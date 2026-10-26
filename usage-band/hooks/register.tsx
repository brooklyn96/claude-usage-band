import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { Limit, Tokens } from '../types'
import { PILL_H, STRIP_BG, alt, fableLimit, isRate, pillSvg, pillsOf, termLayout } from './pills'
import type { Pill, ValuePill } from './pills'

const limitsAtom = atom({ plugin: 'usage-band', key: 'limits' } as const, [])
const costAtom = atom({ plugin: 'usage-band', key: 'cost' } as const, null)
const tokensAtom = atom({ plugin: 'usage-band', key: 'tokens' } as const, null)
// `tokens` shape: the value changed from a bare percent to the token reading.
const contextAtom = atom({ plugin: 'usage-band', key: 'context' } as const, null, { shape: 'tokens' })
// When the main thread's last response landed: the prompt cache's warm countdown.
const warmAtom = atom({ plugin: 'usage-band', key: 'cacheWarm' } as const, null)
const nowAtom = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
// The Fable weekly window, which takes the 7d pill's place on a plan with no all-model weekly one.
const fableAtom = atom({ plugin: 'usage-band', key: 'fable' } as const, null)

// When Claude Code's cached usage reading was last looked at.
let fableAt = -Infinity
// A reading older than this, or none, is asked for anew; so is a failed ask, once that long has passed.
const RENEW_MS = 20 * 60_000
// When Claude Code was last asked for a new reading, and whether that ask is still running.
let renewAt = -Infinity
let renewing = false

/**
 * The Fable weekly window in the usage reply Claude Code caches in its global config file, which no mod
 * event carries. The file is found as Claude Code finds it (legacy file in the config home, ~/.claude;
 * main file in the home). `undefined` when it cannot be read or parsed (it is rewritten often); `null`
 * when it parses without a live entry.
 */
async function cached($: EngineInterface, now: number): Promise<Limit | null | undefined> {
  try {
    // Claude Code's own home: `os.homedir()`, which is USERPROFILE on Windows and HOME elsewhere.
    const windows = (await $.env.get('OS')) === 'Windows_NT'
    const home = windows ? (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) : (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    // Claude Code 2.1.310 V_(): `<CLAUDE_CONFIG_DIR ?? ~/.claude>/.config.json` when it is a non-empty file, else `<CLAUDE_CONFIG_DIR || ~>/.claude[-custom-oauth].json`.
    const trim = (p: string | undefined) => (p ?? '').replace(/[\\/]+$/, '')
    const base = trim(await $.env.get('CLAUDE_CONFIG_DIR'))
    const homeDir = trim(home)
    if (!base && !homeDir) return undefined
    const legacy = `${base || `${homeDir}/.claude`}/.config.json`
    const stat = await $.fs.stat(legacy).catch(() => null) // rejects when missing: the usual case
    const file = stat?.kind === 'file' && stat.size > 0 ? legacy : `${base || homeDir}/.claude${(await $.env.get('CLAUDE_CODE_CUSTOM_OAUTH_URL')) ? '-custom-oauth' : ''}.json`
    return fableLimit(JSON.parse(await $.fs.read(file)), now)
  } catch {
    return undefined
  }
}

const RENEW_ARGV = ['claude', '-p', '/usage', '--no-session-persistence', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}']

/**
 * Claude Code rewrites that reading only when /usage is opened, so `claude -p /usage` (no model call, no
 * window) is run to do it: at most once in RENEW_MS and never twice at once, a failure of any kind keeping
 * the last value until the next try. The copy it starts loads this mod too, and the variable stops it
 * from starting another. The extra flags keep that copy from saving a session file, starting MCP servers
 * or running hooks every time.
 */
async function renew($: EngineInterface, now: number) {
  if (renewing || now - renewAt < RENEW_MS) return
  renewing = true
  renewAt = now
  try {
    if (await $.env.get('USAGE_BAND_RENEW')) return
    const { exitCode } = await $.process.run(RENEW_ARGV, { env: { USAGE_BAND_RENEW: '1' }, timeoutMs: 30_000 })
    if (exitCode !== 0) return
    const limit = await cached($, await $.clock.now())
    if (limit !== undefined) await update($, fableAtom, () => limit)
  } catch {
    // Could not start, timed out, or refused: the pill keeps what it has.
  } finally {
    renewing = false
  }
}

/**
 * A plan with no `seven_day` window (Team) still has the Fable weekly one in the cached usage reading.
 * Looked at once a minute at most, and only for such a plan; one that cannot be read keeps the last value,
 * and only a file that parses without a live entry clears it. A missing or stale reading is renewed.
 */
async function fable($: EngineInterface, rateLimits: readonly SessionRateLimit[]) {
  if (rateLimits.some(l => l.kind === 'seven_day')) return update($, fableAtom, () => null)
  // No reading yet, or the windows were reset (a new login): nothing says which plan this is.
  if (rateLimits.length === 0) {
    fableAt = -Infinity
    return update($, fableAtom, () => null)
  }
  const now = await $.clock.now()
  if (now - fableAt < 60_000) return
  fableAt = now
  const limit = await cached($, now)
  if (limit === undefined) return // Unreadable or torn: keep what is drawn until the next look.
  await update($, fableAtom, () => limit)
  // Not awaited: the ask can take 30 s, which no hook or timer should wait for.
  if (!limit?.fetchedAtMs || now - limit.fetchedAtMs > RENEW_MS) void renew($, now)
}

/** `context` only when its fill moved (or on a full reading); `tokens` is absent before the first response. */
async function measured($: EngineInterface, rateLimits: readonly SessionRateLimit[], cost?: SessionCost, context?: SessionContextUsage) {
  const limits = rateLimits.map(({ kind, percentUsed, resetsAt }): Limit => (resetsAt ? { kind, percentUsed, resetsAt } : { kind, percentUsed }))
  await update($, limitsAtom, () => limits)
  await update($, costAtom, () => cost?.usd ?? null)
  await fable($, rateLimits)
  if (context) {
    const next = context.tokens === undefined ? null : { tokens: context.tokens, window: context.window, percent: context.percent }
    await update($, contextAtom, () => next)
  }
}

async function spent($: EngineInterface, u: ModelUsage | null | undefined) {
  if (!u) return
  // Output tokens are no part of the hit rate, so they are not kept.
  await update($, tokensAtom, (t): Tokens => ({
    input: (t?.input ?? 0) + u.input_tokens + u.cache_creation_input_tokens,
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
  // The prompt cache TTL the option names, in ms.
  const warmTtl = (options.cacheTtl === '5m' ? 5 : 60) * 60_000

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
    // Only the main thread's cache matters; a subagent's loop writes its own.
    if (result.usage && e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, warmAtom, () => at)
    }
    return result
  })

  // The compaction summarizer is priced too, and raises no turn.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if ('usage' in result) await spent($, result.usage)
    return result
  })

  on('session.end', async ($, e, next) => {
    // Cost follows the new session's ledger on both, so the token totals, the
    // context fill and the warm countdown start over too: the new session's
    // first measure brings the figures back, its first response the countdown.
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, tokensAtom, () => null)
      await update($, contextAtom, () => null)
      await update($, warmAtom, () => null)
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
    const warmAt = await read($, warmAtom) // subscribes: a response restarts the countdown
    const pills = pillsOf(
      await read($, limitsAtom),
      await read($, tokensAtom),
      await read($, costAtom),
      await $.clock.now(),
      await read($, contextAtom),
      warmAt === null ? null : { at: warmAt, ttl: warmTtl },
      await read($, fableAtom),
    )
    if (pills.length === 0) return next(e)

    const left = pills.filter(p => p.id !== 'cost')
    const cost = pills.find((p): p is ValuePill => p.id === 'cost')

    // Nerd Font text pills belong to the terminal alone; desktop, vscode, mobile and
    // any later surface draw the Svg pills, which wrap on a narrow panel.
    if (e.surface !== 'terminal') {
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
