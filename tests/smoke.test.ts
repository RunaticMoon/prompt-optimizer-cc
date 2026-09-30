import { describe, expect, test } from 'claude-code/testing'

import { register } from '../hooks/register'

describe('register', () => {
  test('the loaded register dispatches session.start without error', async ($, on) => {
    // The kit has already loaded this plugin's register. A core handler
    // beneath answers session.start so the plugin's pass-through `next(e)`
    // can settle, which is what proves the dispatch path runs.
    on('session.start', (_$, e) => ({ cwd: e.cwd }))

    const cwd = '/tmp/prompt-optimizer-smoke'
    const result = await $.session.start({ cwd, surface: 'terminal', isInteractive: true })

    expect(typeof register).toBe('function')
    expect(result.cwd).toBe(cwd)
  })
})
