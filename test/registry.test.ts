import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeartbeatRegistry, parseHeartbeat } from '../src/registry.ts'
import type { SelfIdentity } from '../src/types.ts'
import { FakeClock } from './helpers.ts'

function makeSelf(overrides: Partial<SelfIdentity> = {}): SelfIdentity {
  return {
    name: 'proj-amber',
    ref: 'ct-aaaaaa',
    pid: 100,
    cwd: '/tmp/proj',
    status: 'idle',
    startedAt: 1000,
    heartbeatAt: 1000,
    inbox: '/tmp/home/inbox/ct-aaaaaa',
    ...overrides,
  }
}

function freshHome(clock: FakeClock): string {
  const dir = join(tmpdir(), `crosstalk-registry-${process.pid}-${Math.random().toString(36).slice(2)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'registry'), { recursive: true })
  return dir
}

test('parseHeartbeat validates shape and tolerates junk', () => {
  const good = parseHeartbeat({ name: 'a', ref: 'ct-111', pid: 1, cwd: '/x', status: 'running', startedAt: 1, heartbeatAt: 2, uid: 501 })
  assert.deepEqual(good, { name: 'a', ref: 'ct-111', pid: 1, cwd: '/x', status: 'running', startedAt: 1, heartbeatAt: 2, uid: 501 })
  assert.equal(parseHeartbeat(null), undefined)
  assert.equal(parseHeartbeat({ name: 'a' }), undefined)
  assert.equal(parseHeartbeat({ name: 'a', ref: 'ct-111', pid: 1, cwd: '/x', status: 'nope', startedAt: 1, heartbeatAt: 2 }), undefined)
})

test('writeHeartbeat + readEntry round-trips', () => {
  const clock = new FakeClock()
  const home = freshHome(clock)
  const registry = new HeartbeatRegistry(home, clock.now.bind(clock))
  const self = makeSelf({ heartbeatAt: clock.now() })
  registry.writeHeartbeat(self)
  const entry = registry.readEntry(self.ref)
  assert.ok(entry)
  assert.equal(entry!.name, 'proj-amber')
  assert.equal(entry!.ref, 'ct-aaaaaa')
  assert.equal(entry!.cwd, '/tmp/proj')
  assert.equal(entry!.status, 'idle')
  rmSync(home, { recursive: true, force: true })
})

test('list returns only fresh entries and garbage-collects stale files', () => {
  const clock = new FakeClock()
  const home = freshHome(clock)
  const registry = new HeartbeatRegistry(home, clock.now.bind(clock))
  registry.writeHeartbeat(makeSelf({ name: 'a-fresh', ref: 'ct-aaaa', heartbeatAt: clock.now() }))
  registry.writeHeartbeat(makeSelf({ name: 'b-stale', ref: 'ct-bbbb', heartbeatAt: clock.now() - 30_000 }))
  clock.advance(5_000)
  const peers = registry.list(20_000) // staleAfterMs = 20s; b's last beat is 30s ago
  assert.deepEqual(peers.map((p) => p.name), ['a-fresh'])
  assert.equal(existsSync(join(home, 'registry', 'ct-bbbb.json')), false)
  rmSync(home, { recursive: true, force: true })
})

test('list excludes self by ref', () => {
  const clock = new FakeClock()
  const home = freshHome(clock)
  const registry = new HeartbeatRegistry(home, clock.now.bind(clock))
  registry.writeHeartbeat(makeSelf({ name: 'self', ref: 'ct-me', heartbeatAt: clock.now() }))
  registry.writeHeartbeat(makeSelf({ name: 'other', ref: 'ct-you', heartbeatAt: clock.now() }))
  const peers = registry.list(20_000, 'ct-me')
  assert.deepEqual(peers.map((p) => p.name), ['other'])
  rmSync(home, { recursive: true, force: true })
})

test('resolve distinguishes live, stale, and unknown', () => {
  const clock = new FakeClock()
  const home = freshHome(clock)
  const registry = new HeartbeatRegistry(home, clock.now.bind(clock))
  registry.writeHeartbeat(makeSelf({ name: 'a-live', ref: 'ct-aaaa', heartbeatAt: clock.now() }))
  registry.writeHeartbeat(makeSelf({ name: 'b-stale', ref: 'ct-bbbb', heartbeatAt: clock.now() - 30_000 }))
  clock.advance(5_000)
  assert.equal(registry.resolve({ kind: 'name', name: 'a-live' }, 20_000).kind, 'live')
  assert.equal(registry.resolve({ kind: 'ref', ref: 'ct-aaaa' }, 20_000).kind, 'live')
  const stale = registry.resolve({ kind: 'name', name: 'b-stale' }, 20_000)
  assert.equal(stale.kind, 'stale')
  assert.equal(registry.resolve({ kind: 'name', name: 'nope' }, 20_000).kind, 'unknown')
  rmSync(home, { recursive: true, force: true })
})

test('collectOrphanInboxes removes inboxes of dead refs only', () => {
  const clock = new FakeClock()
  const home = freshHome(clock)
  const registry = new HeartbeatRegistry(home, clock.now.bind(clock))
  registry.writeHeartbeat(makeSelf({ name: 'alive', ref: 'ct-alive', heartbeatAt: clock.now() }))
  mkdirSync(join(home, 'inbox', 'ct-alive'), { recursive: true })
  mkdirSync(join(home, 'inbox', 'ct-gone'), { recursive: true })
  writeFileSync(join(home, 'inbox', 'ct-gone', 'msg-1.json'), '{}')
  registry.collectOrphanInboxes()
  assert.equal(existsSync(join(home, 'inbox', 'ct-alive')), true)
  assert.equal(existsSync(join(home, 'inbox', 'ct-gone')), false)
  rmSync(home, { recursive: true, force: true })
})

test('a heartbeat left mid-write (tmp file) is never read as an entry', () => {
  const clock = new FakeClock()
  const home = freshHome(clock)
  const registry = new HeartbeatRegistry(home, clock.now.bind(clock))
  writeFileSync(join(home, 'registry', 'ct-partial.json.tmp'), '{"name": "half-')
  assert.equal(registry.list(20_000).length, 0)
  rmSync(home, { recursive: true, force: true })
})
