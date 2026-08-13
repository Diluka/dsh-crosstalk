import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADJECTIVES,
  MAX_NAME_LENGTH,
  NAME_PATTERN,
  REF_PATTERN,
  adjectiveFor,
  cwdSlug,
  currentUid,
  mintRef,
  sessionName,
  slugify,
} from '../src/identity.ts'

test('slugify collapses case, spaces, and punctuation', () => {
  assert.equal(slugify('DSH Cowork'), 'dsh-cowork')
  assert.equal(slugify('My Repo_2'), 'my-repo-2')
  assert.equal(slugify('  UPPER  Case  '), 'upper-case')
  assert.equal(slugify('---'), 'root')
  assert.equal(slugify(''), 'root')
})

test('cwdSlug derives the repo-or-cwd slug from the directory name', () => {
  assert.equal(cwdSlug('/Users/jesse/Documents/DSH'), 'dsh')
  assert.equal(cwdSlug('/Users/jesse/work/dsh-cowork/'), 'dsh-cowork')
  assert.equal(cwdSlug('/'), 'root')
})

test('adjectiveFor is deterministic per (cwd, ref)', () => {
  const a = adjectiveFor('/tmp/proj', 'ct-aaaaaa')
  const b = adjectiveFor('/tmp/proj', 'ct-aaaaaa')
  assert.equal(a, b)
  // Different refs in the same cwd must be able to diverge; across 20 refs
  // at least two distinct adjectives must appear (48-pool, hash spread).
  const seen = new Set<string>()
  for (let i = 0; i < 20; i++) seen.add(adjectiveFor('/tmp/proj', `ct-${String(i).padStart(6, '0')}`))
  assert.ok(seen.size >= 2, `expected divergent adjectives, got ${[...seen].join(', ')}`)
})

test('sessionName composes <slug>-<adjective> within bounds and pattern', () => {
  const name = sessionName('/Users/jesse/work/my-project', 'ct-123456')
  assert.match(name, NAME_PATTERN)
  assert.ok(name.length <= MAX_NAME_LENGTH)
  assert.ok(name.startsWith('my-project-'))
  // Same cwd, different ref -> different names (collision-free addressing).
  assert.notEqual(sessionName('/Users/jesse/work/my-project', 'ct-123456'), sessionName('/Users/jesse/work/my-project', 'ct-654321'))
})

test('mintRef is unique per process and stable for a fixed entropy', () => {
  const ref1 = mintRef('/tmp/x', 1234, 1000)
  const ref2 = mintRef('/tmp/x', 1234, 1000)
  assert.match(ref1, REF_PATTERN)
  assert.notEqual(ref1, ref2) // fresh entropy each call
  const fixed = 'deadbeef'
  assert.equal(mintRef('/tmp/x', 1234, 1000, fixed), mintRef('/tmp/x', 1234, 1000, fixed))
  assert.notEqual(mintRef('/tmp/x', 1234, 1000, fixed), mintRef('/tmp/y', 1234, 1000, fixed))
})

test('currentUid is a safe integer or undefined', () => {
  const uid = currentUid()
  if (uid !== undefined) assert.ok(Number.isSafeInteger(uid))
})

test('adjective pool is non-empty and names are slug-safe', () => {
  assert.ok(ADJECTIVES.length >= 24)
  for (const word of ADJECTIVES) assert.match(word, /^[a-z]+$/)
})
