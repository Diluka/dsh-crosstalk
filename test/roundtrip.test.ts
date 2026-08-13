import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Crosstalk, resolveConfig } from '../src/index.ts'
import { FakeAgent, FakeClock } from './helpers.ts'

test('resolveConfig applies defaults and validates accept/name', () => {
  const clock = new FakeClock()
  const resolved = resolveConfig({ homeDir: '/tmp/ct-home', cwd: '/Users/jesse/work/my-repo', now: clock.now.bind(clock) })
  assert.equal(resolved.accept, 'same-user')
  assert.equal(resolved.mode, 'open')
  assert.equal(resolved.notifyUser, true)
  assert.equal(resolved.staleAfterMs, 20_000) // 2x default heartbeat
  assert.equal(resolved.heartbeatIntervalMs, 10_000)
  assert.match(resolved.name, /^my-repo-[a-z]+$/)
  assert.match(resolved.ref, /^ct-[0-9a-f]{6,}$/)
  assert.throws(() => resolveConfig({ accept: 'anyone' }), /only "same-user"/)
  assert.throws(() => resolveConfig({ name: 'Bad Name!' }), /must match/)
})

test('two sessions exchange a round-trip through a shared home directory', async () => {
  const clock = new FakeClock()
  const home = join(tmpdir(), `crosstalk-rt-${process.pid}-${Math.random().toString(36).slice(2)}`)
  rmSync(home, { recursive: true, force: true })

  const agentA = new FakeAgent('session-a', '/tmp/proj-a')
  const agentB = new FakeAgent('session-b', '/tmp/proj-b')
  const a = new Crosstalk(new Context(), resolveConfig({ homeDir: home, cwd: '/tmp/proj-a', now: clock.now.bind(clock) }), {
    resolveRoots: () => [agentA.toAgent()],
  })
  const b = new Crosstalk(new Context(), resolveConfig({ homeDir: home, cwd: '/tmp/proj-b', now: clock.now.bind(clock) }), {
    resolveRoots: () => [agentB.toAgent()],
  })

  // Both publish heartbeats; each sees the other as a live peer.
  a.tickHeartbeat()
  b.tickHeartbeat()
  const peersOfB = b.peers().map((peer) => peer.name)
  assert.ok(peersOfB.includes(a.self().name))
  assert.ok(!peersOfB.includes(b.self().name))

  // A -> B.
  const sent = await a.send(b.self().name, { text: 'ping from A', summary: 'round trip' })
  assert.match(sent.messageId, /^msg-/)
  assert.equal(sent.to.name, b.self().name)
  assert.equal(existsSync(join(home, 'inbox', b.self().ref, `${sent.messageId}.json`)), true)

  // B's watcher delivers the labeled turn to B's live agent.
  b.drainInbox()
  assert.equal(agentB.followups.length, 1)
  const inbound = agentB.followups[0]!
  const text = (inbound.content[0] as { type: 'text'; text: string }).text
  assert.ok(text.startsWith(`[message from session ${a.self().name} (/tmp/proj-a)]`))
  assert.ok(text.includes('Summary: round trip'))
  assert.ok(text.includes('ping from A'))
  assert.equal(inbound.source.kind, 'crosstalk')
  assert.equal((inbound.source as { form: string }).form, 'relay')
  assert.equal((inbound.source as { senderSessionId?: string }).senderSessionId, 'session-a')
  assert.equal(existsSync(join(home, 'inbox', b.self().ref, `${sent.messageId}.json`)), false) // consumed

  // B replies by A's name; A's watcher delivers it back.
  const reply = await b.send(a.self().name, { text: 'pong from B' })
  a.drainInbox()
  assert.equal(agentA.followups.length, 1)
  const back = agentA.followups[0]!
  assert.ok((back.content[0] as { text: string }).text.startsWith(`[message from session ${b.self().name} (/tmp/proj-b)]`))
  assert.equal(back.source.kind, 'crosstalk')
  void reply

  a.stop()
  b.stop()
  assert.equal(existsSync(join(home, 'registry', a.self().ref + '.json')), false) // heartbeat removed on stop
  rmSync(home, { recursive: true, force: true })
})

test('sending to a stale peer is rejected as not-live', async () => {
  const clock = new FakeClock()
  const home = join(tmpdir(), `crosstalk-stale-${process.pid}-${Math.random().toString(36).slice(2)}`)
  rmSync(home, { recursive: true, force: true })
  const agentA = new FakeAgent('session-a', '/tmp/proj-a')
  const agentB = new FakeAgent('session-b', '/tmp/proj-b')
  const a = new Crosstalk(new Context(), resolveConfig({ homeDir: home, cwd: '/tmp/proj-a', now: clock.now.bind(clock) }), {
    resolveRoots: () => [agentA.toAgent()],
  })
  const b = new Crosstalk(new Context(), resolveConfig({ homeDir: home, cwd: '/tmp/proj-b', now: clock.now.bind(clock) }), {
    resolveRoots: () => [agentB.toAgent()],
  })
  a.tickHeartbeat()
  b.tickHeartbeat()
  // B stops beating; long enough for the staleness window (2x 10s default).
  clock.advance(30_000)
  await assert.rejects(() => a.send(b.self().name, { text: 'hello?' }), /not currently live/)
  a.stop()
  b.stop()
  rmSync(home, { recursive: true, force: true })
})

test('status reflects the live root agent (running/idle/ready)', () => {
  const clock = new FakeClock()
  const home = join(tmpdir(), `crosstalk-status-${process.pid}-${Math.random().toString(36).slice(2)}`)
  rmSync(home, { recursive: true, force: true })
  const agent = new FakeAgent('session-s', '/tmp/proj-s')
  const s = new Crosstalk(new Context(), resolveConfig({ homeDir: home, cwd: '/tmp/proj-s', now: clock.now.bind(clock) }), {
    resolveRoots: () => [agent.toAgent()],
  })
  s.tickHeartbeat()
  assert.equal(s.self().status, 'idle')
  agent.status = 'running'
  s.tickHeartbeat()
  assert.equal(s.self().status, 'running')
  const bare = new Crosstalk(new Context(), resolveConfig({ homeDir: home, cwd: '/tmp/proj-bare', now: clock.now.bind(clock) }), {
    resolveRoots: () => [],
  })
  bare.tickHeartbeat()
  assert.equal(bare.self().status, 'ready')
  s.stop()
  bare.stop()
  rmSync(home, { recursive: true, force: true })
})

test('two sessions in the same cwd get distinct names and refs', () => {
  const clock = new FakeClock()
  const a = resolveConfig({ homeDir: '/tmp/ct', cwd: '/tmp/proj', now: clock.now.bind(clock) })
  const b = resolveConfig({ homeDir: '/tmp/ct', cwd: '/tmp/proj', now: clock.now.bind(clock) })
  assert.notEqual(a.ref, b.ref)
  assert.notEqual(a.name, b.name)
})
