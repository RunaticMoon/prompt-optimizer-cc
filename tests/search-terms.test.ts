import { describe, expect, test } from 'claude-code/testing'

import {
  BUILTIN_ALIASES,
  SEARCH_LATIN_LIMIT,
  SEARCH_TERM_LIMIT,
  aliasGroupKey,
  extractPaths,
  extractSearchTerms,
  extractTargets,
  parseProjectAliases,
  safeRelativePath,
} from '../hooks/search-terms'

function terms(text: string, aliases?: readonly (readonly string[])[]): string[] {
  return extractSearchTerms(text, aliases).map(term => term.text)
}

function weightOf(text: string, needle: string): number | undefined {
  return extractSearchTerms(text).find(term => term.text === needle)?.weight
}

describe('extractSearchTerms', () => {
  test('finds Korean-only login and cart concepts through reversible aliases', () => {
    const login = extractSearchTerms('로그인 오류를 고쳐줘')
    const cart = extractSearchTerms('장바구니 담기 기능을 추가해줘')

    expect(login.map(term => term.text)).toContain('로그인')
    expect(login.map(term => term.text)).toContain('login')
    expect(login.map(term => term.text)).toContain('auth')
    expect(cart.map(term => term.text)).toContain('장바구니')
    expect(cart.map(term => term.text)).toContain('cart')
    expect(cart.map(term => term.text)).toContain('basket')
    expect(login.some(term => term.text === '오류')).toBe(false)
    expect(login.some(term => term.text === '고쳐줘')).toBe(false)
  })

  test('keeps English to Hangul reverse lookup and every legacy alias', () => {
    expect(terms('login API')).toContain('로그인')
    expect(terms('cart page')).toContain('장바구니')

    const legacy: ReadonlyArray<readonly [string, string[]]> = [
      ['노드', ['node']],
      ['이미지', ['image']],
      ['속성', ['property', 'properties']],
      ['이력', ['history', 'change']],
      ['차이', ['diff']],
      ['스웨거', ['swagger', 'openapi']],
    ]
    for (const [word, expected] of legacy) {
      const found = terms(`${word} 확인`)
      for (const alias of expected) expect(found).toContain(alias)
    }
  })

  test('keeps the raw Hangul token and at most one particle-stripped stem', () => {
    const found = terms('로그인은 실패')
    expect(found).toContain('로그인은')
    expect(found).toContain('로그인')

    const oneSyllable = terms('물은 뜨겁다')
    expect(oneSyllable).toContain('물은')
    expect(oneSyllable).not.toContain('물')
  })

  test('drops a request ending only after a known alias stem', () => {
    expect(terms('로그인해줘')).toContain('로그인')
    expect(terms('찜목록해줘')).not.toContain('찜목록')
  })

  test('retains unknown Hangul nouns for comment and identifier matching', () => {
    const found = extractSearchTerms('찜목록을 보여줘')
    expect(found.map(term => term.text)).toContain('찜목록을')
    expect(found.map(term => term.text)).toContain('찜목록')
    expect(weightOf('찜목록을 보여줘', '찜목록')).toBe(16)
  })

  test('normalizes NFC without mutating the caller text', () => {
    const decomposed = '로그인'.normalize('NFD')
    expect(extractSearchTerms(decomposed).map(term => term.text)).toContain('로그인')
    expect(decomposed).not.toBe('로그인')
  })

  test('keeps mixed code identifiers, quoted two-letter names, and paths', () => {
    const found = extractSearchTerms('`ui`와 addCartItem, src/auth/login.ts를 고쳐줘')
    expect(found.map(term => term.text)).toContain('ui')
    expect(found.map(term => term.text)).toContain('addcartitem')
    const path = found.find(term => term.text === 'src/auth/login.ts')
    expect(path?.weight).toBe(128)
  })

  test('expands project aliases in both directions without recursion', () => {
    const aliases = parseProjectAliases('찜목록: wishList, favorites')
    expect(terms('찜목록 화면', aliases)).toContain('wishlist')
    expect(terms('wishList 화면', aliases)).toContain('찜목록')
    expect(terms('favorites 화면', aliases)).toContain('찜목록')
  })

  test('a project mapping on a built-in surface expands forward too', () => {
    const cart = terms('장바구니 화면', parseProjectAliases('장바구니: shoppingBag'))
    expect(cart).toContain('shoppingbag')
    expect(cart).toContain('cart')
    const login = terms('로그인 기능', parseProjectAliases('로그인: sessionStore'))
    expect(login).toContain('sessionstore')
    expect(login).toContain('auth')
  })

  test('ranks direct input above aliases', () => {
    expect(weightOf('login API', 'login')).toBeGreaterThan(weightOf('login API', '로그인') ?? 0)
    expect(weightOf('로그인 API', '로그인')).toBeGreaterThan(weightOf('로그인 API', 'login') ?? 0)
  })

  test('caps terms at 28 and keeps direct Latin tokens within its own cap', () => {
    const identifiers = Array.from({ length: 40 }, (_, index) => `feature${index}`)
    const nouns = ['사용자', '관리자', '대시보드', '알림', '설정', '보고서', '일정', '목록']
    const found = extractSearchTerms(`src/one/target.ts ${identifiers.join(' ')} ${nouns.join(' ')}`)
    expect(found).toHaveLength(SEARCH_TERM_LIMIT)
    expect(found[0]?.text).toBe('src/one/target.ts')
    expect(found.filter(term => term.weight === 32).length).toBeLessThanOrEqual(SEARCH_LATIN_LIMIT)
  })

  test('sorts alias expansion deterministically by code point', () => {
    const first = extractSearchTerms('cart login').filter(term => term.weight === 8).map(term => term.text)
    const second = extractSearchTerms('login cart').filter(term => term.weight === 8).map(term => term.text)
    expect(first).toEqual(second)
    expect(new Set(first).size).toBe(first.length)
  })

  test('built-in concept keys are the documented table keys', () => {
    const login = extractSearchTerms('로그인').find(term => term.text === 'login')
    expect(login?.key).toBe('login')
    const property = extractSearchTerms('속성').find(term => term.text === 'properties')
    expect(property?.key).toBe('property')
    expect(BUILTIN_ALIASES.length).toBe(15)
  })
})

describe('extractTargets', () => {
  test('returns known concepts, paths, and code-shaped identifiers', () => {
    const aliases = parseProjectAliases('찜목록: wishList')
    expect(extractTargets('로그인도 같이')).toEqual(['login'])
    expect(extractTargets('src/auth/login.ts')).toEqual(['src/auth/login.ts'])
    expect(extractTargets('addCartItem')).toEqual(['addcartitem'])
    expect(extractTargets('찜목록 기능')).toEqual(['찜목록'])
  })

  test('maps marked Hangul nouns through project aliases', () => {
    const aliases = parseProjectAliases('찜목록: wishList')
    expect(extractTargets('찜목록 화면', aliases)).toEqual([aliasGroupKey(['찜목록', 'wishlist'])])
  })

  test('never resolves a choice number and ignores presentation-only text', () => {
    for (const text of ['1번', '아까 고른 것', '그대로', '더 짧게', '한국어를 유지해']) {
      expect(extractTargets(text)).toEqual([])
    }
  })

  test('a particle-stripped unknown noun is not a target without a marker', () => {
    expect(extractTargets('문장을 더 자연스럽게')).toEqual([])
    expect(extractTargets('어색한 부분을 고쳐줘')).toEqual([])
    // The marker path still answers with the already-seen concept only.
    expect(extractTargets('로그인 화면으로 보여줘')).toEqual(['login'])
  })

  test('a marker noun keeps its concept identity after one particle', () => {
    expect(extractTargets('로그인을 화면에 보여줘')).toEqual(['login'])
    expect(extractTargets('장바구니를 화면에 표시해줘')).toEqual(['cart'])
  })

  test('adverbial and generic style captures are not marker targets', () => {
    expect(extractTargets('자연스럽게 처리해줘')).toEqual([])
    expect(extractTargets('이 부분을 대상으로 다듬어줘')).toEqual([])
    expect(extractTargets('기능 화면')).toEqual([])
  })

  test('an unknown marker noun is still a new target, with or without a particle', () => {
    expect(extractTargets('대시보드 화면')).toEqual(['대시보드'])
    expect(extractTargets('대시보드를 화면에')).toEqual(['대시보드'])
  })

  test('collapses repeated alias surfaces into one canonical target', () => {
    expect(extractTargets('로그인 login auth')).toEqual(['login'])
  })

  test('rejects unsafe path hints', () => {
    for (const text of ['../secret/file.ts', '/etc/passwd.ts', '.hidden/file.ts', 'src\\auth\\login.ts']) {
      expect(extractPaths(text)).toEqual([])
    }
    expect(safeRelativePath('src/auth/login.ts')).toBe(true)
  })
})

describe('parseProjectAliases', () => {
  test('accepts colon, table, bullet, and backticked explicit rows', () => {
    const text = [
      '# Glossary',
      '| 용어 | 별칭 |',
      '| --- | --- |',
      '- 장바구니: basketStore, cartItems',
      '| 회원가입 | signup, `register` |',
      '`결제`: payment, checkout',
      '노트: 이 파일은 일반 설명입니다.',
      'This sentence is prose, not a mapping.',
      'script: $(rm -rf /)',
      'url: https://example.com/cart',
      'path: src/cart/cart.ts',
      '장바구니: basketStore, cartItems',
    ].join('\n')
    const groups = parseProjectAliases(text)
    expect(groups).toEqual([
      ['장바구니', 'basketStore', 'cartItems'],
      ['회원가입', 'signup', 'register'],
      ['결제', 'payment', 'checkout'],
    ])
  })

  test('accepts numeric excerpt prefixes and caps groups at 16', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `${index + 1}: 기능${index}: alias${index}`)
    expect(parseProjectAliases(lines.join('\n'))).toHaveLength(16)
    expect(parseProjectAliases('1: 찜목록: wishList')).toEqual([['찜목록', 'wishList']])
  })

  test('rejects malformed, command, prose, and duplicate rows', () => {
    expect(parseProjectAliases('장바구니: one two')).toEqual([])
    expect(parseProjectAliases('장바구니: one, two, three, four, five')).toEqual([])
    expect(parseProjectAliases('장바구니: a/b')).toEqual([])
    expect(parseProjectAliases('장바구니: `${cmd}`')).toEqual([])
    expect(parseProjectAliases('장바구니: cart\n장바구니: cart')).toEqual([['장바구니', 'cart']])
  })
})
