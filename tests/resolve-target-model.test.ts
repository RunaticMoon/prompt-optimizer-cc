/**
 * Unit tests for `resolveTargetModel` (DESIGN-model-guidance §6.4, §8 감지).
 *
 * Every test drives deterministic fake ports: the getter and the timer are
 * promises the test settles by hand, so no real 500 ms wait ever runs. The
 * fake timer mirrors `$.clock.sleep` by rejecting as soon as its signal
 * aborts.
 */

import { describe, expect, test } from 'claude-code/testing'

import type {
  EnginePorts,
  ModelResolutionReason,
  TargetModelSnapshot,
} from '../hooks/contracts'
import { TARGET_MODEL_TIMEOUT_MS } from '../hooks/contracts'
import { normalizeTargetModel } from '../hooks/target-model'
import { resolveTargetModel } from '../hooks/resolve-target-model'

function snap(
  raw: string | null,
  normalizedId: string | null,
  profile: TargetModelSnapshot['profile'],
  reason: ModelResolutionReason,
): TargetModelSnapshot {
  return { raw, normalizedId, profile, reason }
}

function common(reason: ModelResolutionReason): TargetModelSnapshot {
  return snap(null, null, 'common', reason)
}

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

type SleepFn = NonNullable<EnginePorts['clock']>['sleep']

interface SleepCall {
  readonly ms: number
  readonly signal: AbortSignal | undefined
  readonly resolve: () => void
  readonly reject: (reason?: unknown) => void
}

interface FakeClock {
  readonly sleep: SleepFn
  readonly calls: SleepCall[]
}

/** A timer whose waits the test fulfils by hand and rejects on abort. */
function fakeClock(): FakeClock {
  const calls: SleepCall[] = []
  const sleep: SleepFn = (ms, options) => {
    const wait = deferred<void>()
    calls.push({
      ms,
      signal: options?.signal,
      resolve: () => wait.resolve(undefined),
      reject: reason => wait.reject(reason),
    })
    const reject = (): void => wait.reject(new Error('sleep aborted'))
    if (options?.signal?.aborted === true) reject()
    else options?.signal?.addEventListener('abort', reject, { once: true })
    return wait.promise
  }
  return { sleep, calls }
}

interface HarnessOptions {
  /** The getter; omit for a missing model port. */
  readonly model?: (() => Promise<string>) | undefined
  /** `present` (default) provides a clock, `missing` omits it, `no-sleep` omits `sleep`. */
  readonly clock?: 'present' | 'missing' | 'no-sleep'
}

interface Harness {
  readonly ports: Pick<EnginePorts, 'session' | 'clock'>
  readonly clock: FakeClock | undefined
  readonly modelCalls: () => number
}

function harness(options: HarnessOptions = {}): Harness {
  let modelCalls = 0
  const getter = options.model
  const session = {
    model:
      getter === undefined
        ? undefined
        : () => {
            modelCalls += 1
            return getter()
          },
  } as unknown as EnginePorts['session']
  let clock: FakeClock | undefined
  let clockPort: EnginePorts['clock']
  if (options.clock === 'missing') {
    clock = undefined
    clockPort = undefined
  } else if (options.clock === 'no-sleep') {
    clock = undefined
    clockPort = {} as unknown as NonNullable<EnginePorts['clock']>
  } else {
    clock = fakeClock()
    clockPort = clock
  }
  return { ports: { session, clock: clockPort }, clock, modelCalls: () => modelCalls }
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

/** Node's `process`, absent from the mod's `es2023` typings. */
const nodeProcess = (
  globalThis as unknown as {
    process?: {
      on: (event: string, listener: (reason: unknown) => void) => void
      off: (event: string, listener: (reason: unknown) => void) => void
    }
  }
).process

interface RejectionTracker {
  readonly count: () => number
  readonly stop: () => void
}

/** Counts `unhandledRejection` while a test settles late rejections. */
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

describe('resolveTargetModel — disabled and pre-aborted', () => {
  test('disabled returns common/disabled and touches neither getter nor timer', async () => {
    const h = harness({ model: async () => 'claude-opus-5-5[1m]' })

    const result = await resolveTargetModel(h.ports, false, new AbortController().signal)

    expect(result).toStrictEqual(common('disabled'))
    expect(h.modelCalls()).toBe(0)
    expect(h.clock?.calls).toHaveLength(0)
  })

  test('an already aborted signal returns common/cancelled with zero calls', async () => {
    const h = harness({ model: async () => 'claude-opus-5-5[1m]' })
    const controller = new AbortController()
    controller.abort()

    const result = await resolveTargetModel(h.ports, true, controller.signal)

    expect(result).toStrictEqual(common('cancelled'))
    expect(h.modelCalls()).toBe(0)
    expect(h.clock?.calls).toHaveLength(0)
  })
})

describe('resolveTargetModel — missing ports', () => {
  test('a missing model port returns common/unavailable without touching the timer', async () => {
    const h = harness({ clock: 'present' })

    const result = await resolveTargetModel(h.ports, true, new AbortController().signal)

    expect(result).toStrictEqual(common('unavailable'))
    expect(h.clock?.calls).toHaveLength(0)
  })

  test('a missing clock port returns common/unavailable without calling the getter', async () => {
    const h = harness({ model: async () => 'claude-opus-5-5', clock: 'missing' })

    const result = await resolveTargetModel(h.ports, true, new AbortController().signal)

    expect(result).toStrictEqual(common('unavailable'))
    expect(h.modelCalls()).toBe(0)
  })

  test('a clock without sleep returns common/unavailable without calling the getter', async () => {
    const h = harness({ model: async () => 'claude-opus-5-5', clock: 'no-sleep' })

    const result = await resolveTargetModel(h.ports, true, new AbortController().signal)

    expect(result).toStrictEqual(common('unavailable'))
    expect(h.modelCalls()).toBe(0)
  })
})

describe('resolveTargetModel — success', () => {
  test('maps a raw model to its profile, preserving the raw string', async () => {
    const h = harness({ model: async () => 'claude-opus-5-5[1m]' })
    const pending = resolveTargetModel(h.ports, true, new AbortController().signal)

    await Promise.resolve()
    expect(h.modelCalls()).toBe(1)
    expect(h.clock?.calls).toHaveLength(1)

    const result = await pending
    expect(result).toStrictEqual(
      snap('claude-opus-5-5[1m]', 'claude-opus-5-5', 'opus-5-5', 'matched'),
    )
  })

  test(`waits with TARGET_MODEL_TIMEOUT_MS (${TARGET_MODEL_TIMEOUT_MS}) and aborts the timer on exit`, async () => {
    const h = harness({ model: async () => 'claude-opus-5-5[1m]' })
    const pending = resolveTargetModel(h.ports, true, new AbortController().signal)
    await pending

    const call = h.clock?.calls[0]
    expect(call?.ms).toBe(TARGET_MODEL_TIMEOUT_MS)
    expect(h.clock?.calls).toHaveLength(1)
    // Cleanup aborted the resolver-owned timer signal.
    expect(call?.signal?.aborted).toBe(true)
  })

  test('passes the getter value straight through normalizeTargetModel', async () => {
    for (const value of ['opus', '', 'claude-opus-5-6', '  Claude Opus 4.8  ']) {
      const h = harness({ model: async () => value })
      const pending = resolveTargetModel(h.ports, true, new AbortController().signal)
      const result = await pending
      expect(result).toStrictEqual(normalizeTargetModel(value))
      expect(result.raw).toBe(value)
    }
  })

  test('a non-string getter value still resolves through the normalizer', async () => {
    const h = harness({ model: async () => null as unknown as string })
    const pending = resolveTargetModel(h.ports, true, new AbortController().signal)
    const result = await pending
    expect(result).toStrictEqual(snap(null, null, 'common', 'empty'))
  })
})

describe('resolveTargetModel — getter failure', () => {
  test('a synchronous throw is common/error', async () => {
    const h = harness({
      model: () => {
        throw new Error('getter exploded')
      },
    })
    const result = await resolveTargetModel(h.ports, true, new AbortController().signal)
    expect(result).toStrictEqual(common('error'))
  })

  test('a rejection is common/error', async () => {
    const h = harness({ model: () => Promise.reject(new Error('getter rejected')) })
    const result = await resolveTargetModel(h.ports, true, new AbortController().signal)
    expect(result).toStrictEqual(common('error'))
  })

  test('a rejection with a non-Error reason is common/error', async () => {
    const h = harness({ model: () => Promise.reject('nope') })
    const result = await resolveTargetModel(h.ports, true, new AbortController().signal)
    expect(result).toStrictEqual(common('error'))
  })
})

describe('resolveTargetModel — timer failure', () => {
  test('a synchronous sleep throw is common/error and skips the getter', async () => {
    const h = harness({ model: async () => 'claude-opus-5-5' })
    const ports = {
      session: h.ports.session,
      clock: {
        sleep: () => {
          throw new Error('timer exploded')
        },
      } as unknown as NonNullable<EnginePorts['clock']>,
    }
    const result = await resolveTargetModel(ports, true, new AbortController().signal)
    expect(result).toStrictEqual(common('error'))
    expect(h.modelCalls()).toBe(0)
  })

  test('a timer that resolves before the getter is common/timeout', async () => {
    const h = harness({ model: () => new Promise<string>(() => {}) })
    const pending = resolveTargetModel(h.ports, true, new AbortController().signal)

    h.clock?.calls[0]?.resolve()
    const result = await pending
    expect(result).toStrictEqual(common('timeout'))
  })

  test('a timer that rejects before the getter is common/error', async () => {
    const h = harness({ model: () => new Promise<string>(() => {}) })
    const pending = resolveTargetModel(h.ports, true, new AbortController().signal)

    h.clock?.calls[0]?.reject(new Error('host timer failure'))
    const result = await pending
    expect(result).toStrictEqual(common('error'))
  })

  test('the timer resolving after a success cannot override the result', async () => {
    const h = harness({ model: async () => 'claude-opus-5-5[1m]' })
    const pending = resolveTargetModel(h.ports, true, new AbortController().signal)
    const result = await pending
    expect(result.reason).toBe('matched')
    // The late resolve is absorbed by the settled guard.
    h.clock?.calls[0]?.resolve()
    expect(result.reason).toBe('matched')
  })
})

/** Ports whose `sleep` returns `value` without being awaitable. */
function brokenSleepPorts(
  h: Harness,
  value: unknown,
): Pick<EnginePorts, 'session' | 'clock'> {
  return {
    session: h.ports.session,
    clock: { sleep: () => value } as unknown as NonNullable<EnginePorts['clock']>,
  }
}

describe('resolveTargetModel — a sleep that never started', () => {
  test('a non-thenable return does not reject; a ready getter still maps', async () => {
    for (const value of [undefined, {}]) {
      const h = harness({ model: async () => 'claude-opus-5-5[1m]' })

      const result = await resolveTargetModel(
        brokenSleepPorts(h, value),
        true,
        new AbortController().signal,
      )

      expect(result).toStrictEqual(
        snap('claude-opus-5-5[1m]', 'claude-opus-5-5', 'opus-5-5', 'matched'),
      )
      expect(h.modelCalls()).toBe(1)
    }
  })

  test('a non-thenable return with a pending getter is common/error', async () => {
    for (const value of [undefined, {}]) {
      const h = harness({ model: () => new Promise<string>(() => {}) })

      const result = await resolveTargetModel(
        brokenSleepPorts(h, value),
        true,
        new AbortController().signal,
      )

      expect(result).toStrictEqual(common('error'))
      expect(h.modelCalls()).toBe(1)
    }
  })

  test('a non-thenable return leaves no unhandled rejection', async () => {
    const tracker = trackRejections()
    const pending: Array<Promise<TargetModelSnapshot>> = []
    for (const value of [undefined, {}]) {
      const ready = harness({ model: async () => 'claude-opus-5-5[1m]' })
      pending.push(
        resolveTargetModel(brokenSleepPorts(ready, value), true, new AbortController().signal),
      )
      const stuck = harness({ model: () => new Promise<string>(() => {}) })
      pending.push(
        resolveTargetModel(brokenSleepPorts(stuck, value), true, new AbortController().signal),
      )
    }

    await Promise.all(pending)
    await macrotask()
    expect(tracker.count()).toBe(0)
    tracker.stop()
  })
})

describe('resolveTargetModel — cancellation', () => {
  test('aborting during the race is common/cancelled and ends the timer', async () => {
    const h = harness({ model: () => new Promise<string>(() => {}) })
    const controller = new AbortController()
    const pending = resolveTargetModel(h.ports, true, controller.signal)

    controller.abort()
    const result = await pending
    expect(result).toStrictEqual(common('cancelled'))
    expect(h.clock?.calls[0]?.signal?.aborted).toBe(true)
  })

  test('aborting after a success leaves the matched result in place', async () => {
    const h = harness({ model: async () => 'claude-opus-5-5[1m]' })
    const controller = new AbortController()
    const pending = resolveTargetModel(h.ports, true, controller.signal)
    const result = await pending

    controller.abort()
    expect(result.reason).toBe('matched')
  })

  test('aborting after a timeout leaves the timeout result in place', async () => {
    const h = harness({ model: () => new Promise<string>(() => {}) })
    const controller = new AbortController()
    const pending = resolveTargetModel(h.ports, true, controller.signal)
    h.clock?.calls[0]?.resolve()
    const result = await pending

    controller.abort()
    expect(result.reason).toBe('timeout')
  })
})

describe('resolveTargetModel — listener cleanup', () => {
  test('the external abort listener is removed after a success', async () => {
    const h = harness({ model: async () => 'claude-opus-5-5[1m]' })
    const signal = manualSignal()
    const result = await resolveTargetModel(h.ports, true, signal.signal)

    expect(result.reason).toBe('matched')
    expect(signal.added()).toBe(1)
    expect(signal.removed()).toBe(1)
    // A late abort cannot reach the settled resolver.
    signal.fire()
    expect(result.reason).toBe('matched')
  })

  test('the external abort listener is removed after a cancellation', async () => {
    const h = harness({ model: () => new Promise<string>(() => {}) })
    const signal = manualSignal()
    const pending = resolveTargetModel(h.ports, true, signal.signal)

    signal.fire()
    const result = await pending
    expect(result.reason).toBe('cancelled')
    expect(signal.added()).toBe(1)
    expect(signal.removed()).toBe(1)
    // Firing again reaches no listener.
    signal.fire()
    expect(result.reason).toBe('cancelled')
  })
})

describe('resolveTargetModel — late results are absorbed', () => {
  test('a late getter success after a timeout changes nothing', async () => {
    const late = deferred<string>()
    const h = harness({ model: () => late.promise })
    const pending = resolveTargetModel(h.ports, true, new AbortController().signal)

    h.clock?.calls[0]?.resolve()
    const result = await pending
    expect(result).toStrictEqual(common('timeout'))

    late.resolve('claude-opus-5-5[1m]')
    await macrotask()
    expect(result).toStrictEqual(common('timeout'))
  })

  test('a late getter rejection after a timeout leaves no unhandled rejection', async () => {
    const tracker = trackRejections()
    const late = deferred<string>()
    const h = harness({ model: () => late.promise })
    const pending = resolveTargetModel(h.ports, true, new AbortController().signal)

    h.clock?.calls[0]?.resolve()
    const result = await pending
    expect(result).toStrictEqual(common('timeout'))

    late.reject(new Error('late failure'))
    await macrotask()
    expect(result).toStrictEqual(common('timeout'))
    expect(tracker.count()).toBe(0)
    tracker.stop()
  })

  test('a late getter rejection after a cancellation leaves no unhandled rejection', async () => {
    const tracker = trackRejections()
    const late = deferred<string>()
    const h = harness({ model: () => late.promise })
    const controller = new AbortController()
    const pending = resolveTargetModel(h.ports, true, controller.signal)

    controller.abort()
    const result = await pending
    expect(result).toStrictEqual(common('cancelled'))

    late.reject(new Error('late failure'))
    await macrotask()
    expect(result).toStrictEqual(common('cancelled'))
    expect(tracker.count()).toBe(0)
    tracker.stop()
  })

  test('the aborted sleep rejection is absorbed on every exit', async () => {
    const tracker = trackRejections()
    const cases: ReadonlyArray<() => Promise<TargetModelSnapshot>> = [
      // success
      () => {
        const h = harness({ model: async () => 'claude-opus-5-5[1m]' })
        return resolveTargetModel(h.ports, true, new AbortController().signal)
      },
      // timeout
      () => {
        const h = harness({ model: () => new Promise<string>(() => {}) })
        const pending = resolveTargetModel(h.ports, true, new AbortController().signal)
        h.clock?.calls[0]?.resolve()
        return pending
      },
      // error
      () => {
        const h = harness({ model: () => Promise.reject(new Error('x')) })
        return resolveTargetModel(h.ports, true, new AbortController().signal)
      },
      // cancelled
      () => {
        const h = harness({ model: () => new Promise<string>(() => {}) })
        const controller = new AbortController()
        const pending = resolveTargetModel(h.ports, true, controller.signal)
        controller.abort()
        return pending
      },
    ]

    const results = await Promise.all(cases.map(run => run()))
    await macrotask()
    expect(results.map(result => result.reason)).toStrictEqual([
      'matched',
      'timeout',
      'error',
      'cancelled',
    ])
    expect(tracker.count()).toBe(0)
    tracker.stop()
  })
})

describe('resolveTargetModel — no caching between calls', () => {
  test('a first success is not reused when the second call fails', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let index = 0
    const h = harness({
      model: () => {
        index += 1
        return index === 1 ? first.promise : second.promise
      },
    })
    const signal = new AbortController().signal

    const pendingOne = resolveTargetModel(h.ports, true, signal)
    first.resolve('claude-opus-5-5[1m]')
    const one = await pendingOne
    expect(one).toStrictEqual(
      snap('claude-opus-5-5[1m]', 'claude-opus-5-5', 'opus-5-5', 'matched'),
    )
    expect(h.clock?.calls).toHaveLength(1)

    const pendingTwo = resolveTargetModel(h.ports, true, signal)
    second.reject(new Error('second read fails'))
    const two = await pendingTwo

    expect(two).toStrictEqual(common('error'))
    expect(h.modelCalls()).toBe(2)
    expect(h.clock?.calls).toHaveLength(2)
  })

  test('each call starts and settles its own timer', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let index = 0
    const h = harness({
      model: () => {
        index += 1
        return index === 1 ? first.promise : second.promise
      },
    })
    const signal = new AbortController().signal

    const pendingOne = resolveTargetModel(h.ports, true, signal)
    first.resolve('claude-opus-5-5[1m]')
    await pendingOne

    const pendingTwo = resolveTargetModel(h.ports, true, signal)
    h.clock?.calls[1]?.resolve()
    const two = await pendingTwo

    expect(two).toStrictEqual(common('timeout'))
    expect(h.clock?.calls[0]?.signal?.aborted).toBe(true)
    expect(h.clock?.calls[1]?.signal?.aborted).toBe(true)
  })
})
