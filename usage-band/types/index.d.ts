export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Tokens = { input: number; output: number; cache: number }
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
      now: number
    }
  }
}
