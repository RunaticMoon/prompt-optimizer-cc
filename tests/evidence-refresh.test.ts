import { describe, expect, test } from 'claude-code/testing'

import { CONTEXT_PROJECT_CHARS, CONTEXT_TOTAL_CHARS } from '../hooks/contracts'
import {
  REFRESH_BLOCK_OVERHEAD,
  REFRESH_MAX_ATTEMPTS,
  REFRESH_MAX_TARGETS,
  appendRefresh,
  entryText,
  initialRefreshState,
  planRefresh,
  refreshAllocation,
  renderRefresh,
  type RefreshState,
} from '../hooks/evidence-refresh'
import { aliasGroupKey, parseProjectAliases } from '../hooks/search-terms'

const OWNER = { sessionId: 'sess-1', workflowId: 'wf-1', generation: 0 }

function state(over: Partial<RefreshState> = {}): RefreshState {
  return {
    owner: OWNER,
    seen: ['login'],
    attempts: 0,
    reserveChars: 1000,
    aliases: initialRefreshState(OWNER, '', '', [], 1000).aliases,
    entries: [],
    ...over,
  }
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

describe('refreshAllocation', () => {
  test('the default path reserves 1,000 of 6,000 and 1,000 of 3,000 project chars', () => {
    expect(refreshAllocation(6000)).toEqual({
      total: 6000,
      reserve: 1000,
      initial: 5000,
      projectReserve: 1000,
      projectInitial: 2000,
    })
  })

  test('clamps huge inputs and handles tiny and zero budgets', () => {
    expect(refreshAllocation(99999).total).toBe(CONTEXT_TOTAL_CHARS)
    expect(refreshAllocation(300)).toEqual({
      total: 300,
      reserve: 50,
      initial: 250,
      projectReserve: 50,
      projectInitial: CONTEXT_PROJECT_CHARS - 50,
    })
    expect(refreshAllocation(5)).toMatchObject({ total: 5, reserve: 0, initial: 5 })
    expect(refreshAllocation(0)).toEqual({
      total: 0,
      reserve: 0,
      initial: 0,
      projectReserve: 0,
      projectInitial: CONTEXT_PROJECT_CHARS,
    })
    expect(refreshAllocation(Number.NaN).total).toBe(0)
  })

  test('initial plus reserve fits the total and project initial plus reserve fits 3,000', () => {
    for (const value of [0, 1, 5, 6, 100, 300, 6000, 8000]) {
      const alloc = refreshAllocation(value)
      expect(alloc.initial + alloc.reserve).toBe(alloc.total)
      expect(alloc.projectInitial + alloc.projectReserve).toBe(CONTEXT_PROJECT_CHARS)
    }
  })
})

describe('initialRefreshState', () => {
  test('seeds canonical keys from the original and user conversation only', () => {
    const aliases = parseProjectAliases('찜목록: wishList')
    const refresh = initialRefreshState(
      OWNER,
      '로그인 오류를 고쳐줘',
      '[user] 장바구니도 같이\n[assistant] 결제도 하면 좋습니다',
      aliases,
      500,
    )
    expect(refresh.seen).toContain('login')
    expect(refresh.seen).toContain('cart')
    expect(refresh.seen).not.toContain('payment')
    expect(refresh.attempts).toBe(0)
    expect(refresh.reserveChars).toBe(500)
    expect(refresh.aliases.length).toBeGreaterThan(0)
  })

  test('clamps the reserve and deduplicates repeated concepts', () => {
    const refresh = initialRefreshState(OWNER, '로그인 login auth', '', [], 99999)
    expect(refresh.seen).toEqual(['login'])
    expect(refresh.reserveChars).toBe(1000)
  })

  test('seeds seen with the concepts the initial scan already searched', () => {
    const refresh = initialRefreshState(OWNER, '대시보드 고쳐줘', '', [], 500)
    expect(refresh.seen).toContain('대시보드')
    // A marker around an already-searched noun must not rescan it.
    expect(planRefresh(refresh, '대시보드 화면으로')).toBeNull()
  })

  test('cap pressure keeps a project concept the initial scan expanded', () => {
    const aliases = parseProjectAliases('별칭: 로그인')
    const fillers = [
      '가람', '고래', '구름', '나무', '노을', '다람', '도시', '라면',
      '마음', '바다', '별빛', '산들', '새벽', '소리', '숲길', '여울',
      '우물', '이슬', '자락', '초록', '하늘', '호수', '희망', '구슬',
    ]
    const request = `${fillers.join(' ')} 장바구니 로그인`
    const refresh = initialRefreshState(OWNER, request, '', aliases, 500)
    // The alias expansion fills the last slots; duplicated groups would spend
    // them on a repeat instead and hide this concept from `seen`.
    expect(refresh.seen).toContain(aliasGroupKey(['별칭', '로그인']))
    expect(planRefresh(refresh, '별칭 모듈도')).toBeNull()
  })
})

describe('planRefresh', () => {
  test('a new alias target authorizes one scan and counts it before the await', () => {
    const plan = planRefresh(state(), '장바구니도 같이 봐줘')
    expect(plan).not.toBeNull()
    expect(plan?.newTargets).toEqual(['cart'])
    expect(plan?.nextState.attempts).toBe(1)
    expect(plan?.nextState.seen).toContain('cart')
    expect(plan?.query).toContain('cart')
    expect(plan?.query).toContain('basket')
  })

  test('a repeated alias, a choice, a deictic phrase, a style change, and a bare retry do nothing', () => {
    for (const text of [
      '로그인 화면',
      '1번',
      '아까 고른 것',
      '그대로 유지해',
      '더 짧게',
      '한국어를 유지해',
      '   ',
    ]) {
      expect(planRefresh(state(), text)).toBeNull()
    }
  })

  test('an unmarked noun with a particle is style prose, not a new target', () => {
    for (const text of ['문장을 더 자연스럽게', '어색한 부분을 고쳐줘', '로그인 화면으로 보여줘']) {
      expect(planRefresh(state(), text)).toBeNull()
    }
  })

  test('a marker noun with one particle repeats the seen concept', () => {
    expect(planRefresh(state({ seen: ['login'] }), '로그인을 화면에 보여줘')).toBeNull()
    expect(planRefresh(state({ seen: ['cart'] }), '장바구니를 화면에 표시해줘')).toBeNull()
  })

  test('adverbial and generic style captures never plan a scan', () => {
    for (const text of ['자연스럽게 처리해줘', '이 부분을 대상으로 다듬어줘']) {
      expect(planRefresh(state(), text)).toBeNull()
    }
  })

  test('a new marker-attached noun plans exactly one scan', () => {
    const plan = planRefresh(state(), '대시보드 화면')
    expect(plan?.newTargets).toEqual(['대시보드'])
    expect(plan?.nextState.attempts).toBe(1)
    expect(plan?.query).toContain('대시보드')
    expect(planRefresh(plan?.nextState ?? state(), '대시보드 화면으로')).toBeNull()
  })

  test('a new explicit path is a new target even for the same concept', () => {
    const initial = state({ seen: ['src/auth/login.ts'] })
    const plan = planRefresh(initial, 'src/auth/session.ts도 확인해줘')
    expect(plan?.newTargets).toEqual(['src/auth/session.ts'])
    expect(plan?.query).toContain('src/auth/session.ts')
  })

  test('a corrected path after an earlier failure is still a new target', () => {
    const failed = { ...state({ seen: ['src/auth/login.ts'] }), attempts: 1 }
    const plan = planRefresh(failed, 'src/auth/session.ts')
    expect(plan?.nextState.attempts).toBe(2)
  })

  test('two attempts are the ceiling and a failed attempt is not refunded', () => {
    let current = state()
    const first = planRefresh(current, '장바구니')
    expect(first?.nextState.attempts).toBe(1)
    current = first?.nextState ?? current
    // No appendRefresh here: the first scan failed but still counts.
    const second = planRefresh(current, '결제')
    expect(second?.nextState.attempts).toBe(REFRESH_MAX_ATTEMPTS)
    current = second?.nextState ?? current
    expect(planRefresh(current, '검색')).toBeNull()
  })

  test('at most eight new targets are sent and marked seen', () => {
    const paths = Array.from({ length: 12 }, (_, index) => `src/part${index}/file${index}.ts`).join(' ')
    const plan = planRefresh(state({ seen: [] }), paths)
    expect(plan?.newTargets).toHaveLength(REFRESH_MAX_TARGETS)
    expect(plan?.nextState.seen).toHaveLength(REFRESH_MAX_TARGETS)
  })

  test('keeps up to four prior explicit identifiers as search hints', () => {
    const initial = state({ seen: ['src/auth/login.ts', 'login'] })
    const plan = planRefresh(initial, 'src/auth/session.ts login도 참고')
    expect(plan?.newTargets).toEqual(['src/auth/session.ts'])
    expect(plan?.query).toContain('src/auth/session.ts')
    expect(plan?.query).toContain('auth')
  })

  test('a zero reserve skips scans entirely', () => {
    expect(planRefresh(state({ reserveChars: 0 }), '장바구니')).toBeNull()
  })
})

describe('appendRefresh and renderRefresh', () => {
  test('keeps newest entries first and deduplicates identical payloads', () => {
    const first = appendRefresh(state(), {
      collectedAt: '2026-10-02T00:00:00.000Z',
      round: 2,
      targets: ['cart'],
      text: 'cart evidence',
    })
    const second = appendRefresh(first, {
      collectedAt: '2026-10-02T00:01:00.000Z',
      round: 3,
      targets: ['payment'],
      text: 'payment evidence',
    })
    expect(second.entries[0]?.text).toBe('payment evidence')
    expect(second.entries[1]?.text).toBe('cart evidence')

    const duplicate = appendRefresh(second, {
      collectedAt: '2026-10-02T00:02:00.000Z',
      round: 4,
      targets: ['payment'],
      text: 'payment evidence',
    })
    expect(duplicate.entries).toHaveLength(2)
    expect(duplicate.entries[0]?.text).toBe('payment evidence')
  })

  test('drops older entries before truncating the newest body', () => {
    const refresh = state({ reserveChars: 220 })
    const first = appendRefresh(refresh, {
      collectedAt: '2026-10-02T00:00:00.000Z', round: 2, targets: ['cart'], text: 'A'.repeat(120),
    })
    const second = appendRefresh(first, {
      collectedAt: '2026-10-02T00:01:00.000Z', round: 3, targets: ['payment'], text: 'B'.repeat(120),
    })
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0]?.text.startsWith('B')).toBe(true)
    expect(renderRefresh(second).length).toBeLessThanOrEqual(220)
  })

  test('bounds headers and bodies to a tiny reserve without splitting a surrogate', () => {
    const refresh = appendRefresh(state({ reserveChars: 90 }), {
      collectedAt: '2026-10-02T00:00:00.000Z',
      round: 2,
      targets: ['cart'],
      text: `😀${'x'.repeat(500)}`,
    })
    const rendered = renderRefresh(refresh)
    expect(rendered.length).toBeLessThanOrEqual(90)
    expect(rendered).toContain('collected: 2026-10-02')
    expect(rendered).toContain('partial, read-only')
    expect(hasLoneSurrogate(rendered)).toBe(false)
  })

  test('bounds long target labels and keeps entries plus separators inside the reserve', () => {
    const targets = Array.from({ length: 10 }, (_, index) => `target-${index}-${'x'.repeat(200)}`)
    let refresh = state({ reserveChars: 400 })
    for (let index = 0; index < 3; index += 1) {
      refresh = appendRefresh(refresh, {
        collectedAt: '2026-10-02T00:00:00.000Z',
        round: index + 2,
        targets: [targets[index] ?? ''],
        text: `evidence-${index}-${'y'.repeat(120)}`,
      })
    }
    expect(renderRefresh(refresh).length).toBeLessThanOrEqual(400)
    expect(refresh.entries.every(entry => entryText(entry).length <= 400)).toBe(true)
  })

  test('the wrapper overhead comes out of the same reserve', () => {
    let refresh = state({ reserveChars: 1000 })
    for (let index = 0; index < 3; index += 1) {
      refresh = appendRefresh(refresh, {
        collectedAt: '2026-10-02T00:00:00.000Z',
        round: index + 2,
        targets: ['cart'],
        text: `evidence-${index}-${'z'.repeat(400)}`,
      })
    }
    const rendered = renderRefresh(refresh, refresh.reserveChars - REFRESH_BLOCK_OVERHEAD)
    expect(rendered.length + REFRESH_BLOCK_OVERHEAD).toBeLessThanOrEqual(1000)
  })

  test('returns an empty block with no entries or no reserve', () => {
    expect(renderRefresh(state())).toBe('')
    expect(renderRefresh(appendRefresh(state({ reserveChars: 0 }), {
      collectedAt: '2026-10-02T00:00:00.000Z', round: 2, targets: ['cart'], text: 'cart',
    }))).toBe('')
  })
})
