import type { On, PluginOptions } from 'claude-code'

/**
 * Mod entry point.
 *
 * Ownership of this file passes to task L once the module wiring lands. For
 * now it only registers a no-op `session.start` hook so `claude plugin test`
 * and `claude plugin validate` have a real module to load.
 */
export function register(on: On, options: PluginOptions): void {
  void options
  on('session.start', async (_$, e, next) => next(e))
}
