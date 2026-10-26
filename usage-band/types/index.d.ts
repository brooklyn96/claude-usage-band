/** `fetchedAtMs`: when Claude Code read a cached limit (the Fable one); absent on a live reading. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string; fetchedAtMs?: number }
/** Session sums: `input` the uncached input plus cache writes, `cache` the cache reads; the hit rate is cache / (input + cache). */
export type Tokens = { input: number; cache: number }
/** The live context reading: the last response's input tokens, its window, and the engine's percent when given. */
export type ContextUsage = { tokens: number; window: number; percent?: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      limits: Limit[]
      cost: number | null
      tokens: Tokens | null
      /** Live context window reading; null before the first response fills it. */
      context: Shaped<ContextUsage | null>
      /** When the main thread's last response landed: the warm countdown's start; null before one, and on clear and resume. */
      cacheWarm: number | null
      /** The Fable weekly window from Claude Code's cached usage reading; it stands in for 7d on a plan with no all-model weekly window. */
      fable: Limit | null
      now: number
    }
  }
}
