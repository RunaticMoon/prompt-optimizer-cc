/**
 * Unit tests for the preparation budget (issue #32, package 32-1).
 *
 * Every wait is a fake clock the test advances by hand: `advance` moves both
 * `now` and the sleeps whose due instant passed, so no real second ever runs.
 * The fake sleep mirrors `$.clock.sleep` by rejecting as soon as its signal
 * aborts.
 */

import { describe, expect, test } from 'claude-code/testing'

import type { EnginePorts } from '../hooks/contracts'
import {
  PREPARATION_STEP_MS,
  PREPARATION_TOTAL_MS,
  PreparationCancelled,
  createPreparationBudget,
  type PreparationBudget,
  type PreparationResult,
} from '../hooks/preparation'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface SleepCall {
  readonly ms: number
  readonly signal: AbortSignal | undefined
  readonly due: number
  readonly resolve: () => void
  readonly reject: (reason?: unknown) => void
  settled: boolean
}

interface FakeClock {
  readonly port: NonNullable<EnginePorts['clock']>
  readonly calls: SleepCall[]
  now(): number
  advance(ms: number): void
}

function fakeClock(start = 1_000): FakeClock {
  let now = start
  const calls: SleepCall[] = []
  const port = {
    sleep: (ms: number, options?: { signal?: AbortSignal }): Promise<void> => {
      const wait = deferred<void>()
      const call: SleepCall = {
        ms,
        signal: options?.signal,
        due: now + ms,
        resolve: () => {
          if (call.settled) return
          call.settled = true
          wait.resolve(undefined)
        },
        reject: reason => {
          if (call.settled) return
          call.settled = true
          wait.reject(reason)
        },
        settled: false,
      }
      calls.push(call)
      const onAbort = (): void => call.reject(new Error('sleep aborted'))
      if (options?.signal?.aborted === true) onAbort()
      else options?.signal?.addEventListener('abort', onAbort, { once: true })
      return wait.promise
    },
  } as unknown as NonNullable<EnginePorts['clock']>
  return {
    port,
    calls,
    now: () => now,
    advance: ms => {
      now += ms
      for (const call of [...calls]) if (call.due <= now) call.resolve()
    },
  }
}

/** An `AbortSignal` stand-in the test fires by hand, counting its listeners. */
interface ManualSignal {
  readonly signal: AbortSignal
  readonly added: () => number
  readonly removed: () => number
  readonly fire: () => void
}

function manualSignal(): ManualSignal {
  let aborted = false
  let added = 0
  let removed = 0
  const listeners = new Set<() => void>()
  const signal = {
    get aborted(): boolean {
      return aborted
    },
    addEventListener: (_type: string, listener: () => void): void => {
      added += 1
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: () => void): void => {
      removed += 1
      listeners.delete(listener)
    },
  }
  return {
    signal: signal as unknown as AbortSignal,
    added: () => added,
    removed: () => removed,
    fire: () => {
      aborted = true
      for (const listener of [...listeners]) listener()
    },
  }
}

interface Harness {
  readonly budget: PreparationBudget
  readonly clock: FakeClock
  readonly signal: ManualSignal
  readonly reused: () => number
}

function harness(options: { totalMs?: number; stepMs?: number; clock?: FakeClock } = {}): Harness {
  const clock = options.clock ?? fakeClock()
  const signal = manualSignal()
  const budget = createPreparationBudget({
    clock: clock.port,
    signal: signal.signal,
    now: clock.now,
    totalMs: options.totalMs,
    stepMs: options.stepMs,
  })
  return { budget, clock, signal, reused: () => signal.added() }
}

/** Tracks `unhandledRejection` while a test settles late rejections. */
interface RejectionTracker {
  readonly count: () => number
  readonly stop: () => void
}

const nodeProcess = (
  globalThis as unknown as {
    process?: {
      on: (event: string, listener: (reason: unknown) => void) => void
      off: (event: string, listener: (reason: unknown) => void) => void
    }
  }
).process

function trackRejections(): RejectionTracker {
  let count = 0
  const listener = (): void => {
    count += 1
  }
  nodeProcess?.on('unhandledRejection', listener)
  return { count: () => count, stop: () => nodeProcess?.off('unhandledRejection', listener) }
}

/** Yields past the microtask checkpoints so a stray rejection would surface. */
function macrotask(): Promise<void> {
  const schedule = (
    globalThis as unknown as { setTimeout: (cb: () => void, ms?: number) => unknown }
  ).setTimeout
  return new Promise<void>(resolve => schedule(() => resolve(), 0))
}

function expectFailure<T>(result: PreparationResult<T>, kind: string): void {
  expect(result.kind).toBe(kind)
  expect('value' in result).toBe(false)
}

describe('preparation budget — success and failure', () => {
  test('a ready task resolves ok and aborts its owned timers', async () => {
    const h = harness()

    const result = await h.budget.run('ready', async () => 'value')

    expect(result).toEqual({ kind: 'ok', value: 'value' })
    // One overall timer plus this step's timer; only the step timer has ended.
    expect(h.clock.calls.length).toBe(2)
    expect(h.clock.calls[0]?.signal?.aborted).toBe(false)
    expect(h.clock.calls[1]?.signal?.aborted).toBe(true)
    expect(h.reused()).toBe(1)
    expect(h.signal.removed()).toBe(0)
    h.budget.dispose()
    expect(h.signal.removed()).toBe(1)
    expect(h.clock.calls[0]?.signal?.aborted).toBe(true)
  })

  test('a synchronous throw and a rejection both become error', async () => {
    const h = harness()

    const thrown = await h.budget.run('throw', (() => {
      throw new Error('sync')
    }) as unknown as () => Promise<never>)
    const rejected = await h.budget.run('reject', () => Promise.reject(new Error('async')))

    expectFailure(thrown, 'error')
    expectFailure(rejected, 'error')
  })

  test('the default step limit is PREPARATION_STEP_MS', async () => {
    const h = harness()
    const pending = h.budget.run('hung', () => new Promise<never>(() => {}))
    expect(h.clock.calls.map(call => call.ms)).toContain(PREPARATION_STEP_MS)

    h.clock.advance(PREPARATION_STEP_MS)
    expectFailure(await pending, 'timeout')
  })
})

describe('preparation budget — timeouts', () => {
  test('a hung task expires at its per-step limit and its signal aborts', async () => {
    const h = harness()
    let stepSignal: AbortSignal | undefined
    const pending = h.budget.run('hung', signal => {
      stepSignal = signal
      return new Promise<never>(() => {})
    })

    expect(stepSignal?.aborted).toBe(false)
    h.clock.advance(PREPARATION_STEP_MS)
    expectFailure(await pending, 'timeout')
    expect(stepSignal?.aborted).toBe(true)
  })

  test('the overall deadline truncates a later step and refuses further work', async () => {
    const h = harness({ stepMs: 500, totalMs: 1_000 })
    const first = h.budget.run('first', () => new Promise<never>(() => {}))

    h.clock.advance(1_000)
    expectFailure(await first, 'budget')
    expect(h.budget.remainingMs()).toBe(0)

    let called = false
    const later = await h.budget.run('later', async () => {
      called = true
      return 1
    })
    expectFailure(later, 'budget')
    expect(called).toBe(false)
  })

  test('a step never receives more than the remaining overall budget', async () => {
    const h = harness({ stepMs: 500, totalMs: 800 })
    const pending = h.budget.run('hung', () => new Promise<never>(() => {}))

    // 800 remains, the 500 ms step wins first.
    h.clock.advance(500)
    expectFailure(await pending, 'timeout')

    const second = h.budget.run('second', () => new Promise<never>(() => {}))
    // Only 300 ms of the round is left, so the child sleep is capped there.
    expect(h.clock.calls[h.clock.calls.length - 1]?.ms).toBe(300)
    h.clock.advance(300)
    // Step and round deadline coincide; the round's budget is the reason.
    expectFailure(await second, 'budget')
  })

  test('an already expired budget skips the task without touching a timer', async () => {
    const h = harness({ totalMs: 100 })
    h.clock.advance(100)

    let called = false
    const result = await h.budget.run('skipped', async () => {
      called = true
      return 1
    })
    expectFailure(result, 'budget')
    expect(called).toBe(false)
    expect(h.clock.calls.length).toBe(1)
  })
})

describe('preparation budget — cancellation', () => {
  test('a pre-aborted signal skips the task', async () => {
    const h = harness()
    h.signal.fire()

    let called = false
    const result = await h.budget.run('skipped', async () => {
      called = true
      return 1
    })
    expectFailure(result, 'cancelled')
    expect(called).toBe(false)
  })

  test('aborting during a hung task resolves cancelled and aborts its signal', async () => {
    const h = harness()
    let stepSignal: AbortSignal | undefined
    const pending = h.budget.run('hung', signal => {
      stepSignal = signal
      return new Promise<never>(() => {})
    })

    h.signal.fire()
    expectFailure(await pending, 'cancelled')
    expect(stepSignal?.aborted).toBe(true)
    expect(h.budget.remainingMs()).toBe(0)
  })

  test('a later step after cancellation is not invoked', async () => {
    const h = harness()
    h.signal.fire()

    let called = false
    const result = await h.budget.run('later', async () => {
      called = true
      return 1
    })
    expectFailure(result, 'cancelled')
    expect(called).toBe(false)
  })

  test('simultaneous completion and abort settle exactly once', async () => {
    const h = harness()
    const task = deferred<string>()
    const pending = h.budget.run('race', () => task.promise)

    task.resolve('value')
    h.signal.fire()
    const result = await pending
    // The abort listener runs synchronously before the queued success.
    expect(result).toEqual({ kind: 'cancelled' })

    // A later release cannot change the settled wrapper.
    task.resolve('again')
    expect(result).toEqual({ kind: 'cancelled' })
  })

  test('dispose settles a pending step, refuses later work and removes the listener', async () => {
    const h = harness()
    const pending = h.budget.run('hung', () => new Promise<never>(() => {}))
    const before = h.clock.calls.map(call => call.signal)

    h.budget.dispose()
    expectFailure(await pending, 'cancelled')
    expect(before.every(signal => signal?.aborted === true)).toBe(true)
    expect(h.signal.removed()).toBe(1)

    let called = false
    const result = await h.budget.run('after', async () => {
      called = true
      return 1
    })
    expectFailure(result, 'cancelled')
    expect(called).toBe(false)
  })
})

describe('preparation budget — unusable host timers', () => {
  test('a missing clock or sleep is unavailable and the task is not invoked', async () => {
    for (const clock of [undefined, {} as NonNullable<EnginePorts['clock']>]) {
      const signal = manualSignal()
      const budget = createPreparationBudget({ clock, signal: signal.signal, now: () => 0 })
      let called = false
      const result = await budget.run('no-timer', async () => {
        called = true
        return 1
      })
      expectFailure(result, 'unavailable')
      expect(called).toBe(false)
      budget.dispose()
    }
  })

  test('a throwing sleep fails closed before the task is invoked', async () => {
    const signal = manualSignal()
    const budget = createPreparationBudget({
      clock: {
        sleep: () => {
          throw new Error('timer exploded')
        },
      } as unknown as NonNullable<EnginePorts['clock']>,
      signal: signal.signal,
      now: () => 0,
    })

    let called = false
    const result = await budget.run('throw', async () => {
      called = true
      return 1
    })
    expectFailure(result, 'error')
    expect(called).toBe(false)
    budget.dispose()
  })

  test('a non-thenable sleep fails closed before the task is invoked', async () => {
    for (const value of [undefined, {}, 0]) {
      const signal = manualSignal()
      const budget = createPreparationBudget({
        clock: { sleep: () => value } as unknown as NonNullable<EnginePorts['clock']>,
        signal: signal.signal,
        now: () => 0,
      })

      let called = false
      const result = await budget.run('non-thenable', async () => {
        called = true
        return 1
      })
      expectFailure(result, 'error')
      expect(called).toBe(false)
      budget.dispose()
    }
  })

  test('a rejecting overall timer settles the running step as error', async () => {
    const h = harness()
    const pending = h.budget.run('hung', () => new Promise<never>(() => {}))

    h.clock.calls[0]?.reject(new Error('host timer failure'))
    expectFailure(await pending, 'error')
  })
})

describe('preparation budget — late settlements and cleanup', () => {
  test('a task resolving or rejecting after a timeout is absorbed', async () => {
    const tracker = trackRejections()
    const h = harness()
    const task = deferred<string>()
    const pending = h.budget.run('hung', () => task.promise)

    h.clock.advance(PREPARATION_STEP_MS)
    expectFailure(await pending, 'timeout')

    task.resolve('late')
    task.reject(new Error('late failure'))
    await macrotask()
    expect(tracker.count()).toBe(0)
    tracker.stop()
    h.budget.dispose()
  })

  test('the caller listener is removed after a success and after a cancellation', async () => {
    const success = harness()
    await success.budget.run('ready', async () => 1)
    expect(success.signal.added()).toBe(1)
    expect(success.signal.removed()).toBe(0)
    success.budget.dispose()
    expect(success.signal.removed()).toBe(1)

    const cancelled = harness()
    const pending = cancelled.budget.run('hung', () => new Promise<never>(() => {}))
    cancelled.signal.fire()
    await pending
    expect(cancelled.signal.added()).toBe(1)
    expect(cancelled.signal.removed()).toBe(1)
    cancelled.budget.dispose()
  })

  test('PreparationCancelled is a distinct named Error', () => {
    const error = new PreparationCancelled()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PreparationCancelled')
  })

  test('the default export limits are the contracted values', () => {
    expect(PREPARATION_TOTAL_MS).toBe(5000)
    expect(PREPARATION_STEP_MS).toBe(500)
  })
})
