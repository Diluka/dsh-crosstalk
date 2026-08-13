import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowlistAllows, decideDelivery, globMatch, InboxWatcher, type DeliveryPolicy } from '../src/deliver.ts'
import { writeMessageFile } from '../src/message.ts'
import type { MessageFile } from '../src/types.ts'
import { FakeAgent, FakeClock } from './helpers.ts'

const SENDER = { name: 'proj-amber', ref: 'ct-aaaa', cwd: '/tmp/proj', uid: 501, sessionId: 'session-1' }

function makeFile(overrides: Partial<MessageFile> = {}): MessageFile {
  return { id: 'msg-1-aaaa', sentAt: 1000, from: SENDER, text: 'hello', ...overrides }
}

function openPolicy(overrides: Partial<DeliveryPolicy> = {}): DeliveryPolicy {
  return { uid: 501, mode: 'open', allowlist: [], notifyUser: true, ...overrides }
}

test('globMatch handles *, **, and ?', () => {
  assert.equal(globMatch('/tmp/proj*', '/tmp/project'), true)
  assert.equal(globMatch('/tmp/proj*', '/tmp/proj/sub'), false) // * stays within a segment
  assert.equal(globMatch('/tmp/**', '/tmp/a/b/c'), true)
  assert.equal(globMatch('/tmp/??o', '/tmp/foo'), true)
  assert.equal(globMatch('/tmp/??o', '/tmp/fooo'), false)
  assert.equal(globMatch('/tmp/proj', '/tmp/project'), false) // literal, no wildcards
  assert.equal(globMatch('', '/tmp'), false)
})

test('allowlistAllows matches exact names and cwd globs', () => {
  const sender = { name: 'proj-amber', cwd: '/tmp/proj' }
  assert.equal(allowlistAllows(['proj-amber'], sender), true)
  assert.equal(allowlistAllows(['other-name'], sender), false)
  assert.equal(allowlistAllows(['/tmp/proj'], sender), true) // exact cwd convenience
  assert.equal(allowlistAllows(['/tmp/*'], sender), true)
  assert.equal(allowlistAllows(['/other/*'], sender), false)
  assert.equal(allowlistAllows([''], sender), false)
})

test('decideDelivery enforces same-user acceptance (v0.1 fixed)', () => {
  assert.equal(decideDelivery(makeFile(), openPolicy()).kind, 'deliver')
  assert.equal(decideDelivery(makeFile({ from: { ...SENDER, uid: 999 } }), openPolicy()).kind, 'drop')
  // uid-less platforms skip the check entirely.
  const noUid = openPolicy({ uid: undefined })
  assert.equal(decideDelivery(makeFile({ from: { ...SENDER, uid: 999 } }), noUid).kind, 'deliver')
})

test('decideDelivery enforces allowlist mode', () => {
  const allow = openPolicy({ mode: 'allowlist', allowlist: ['proj-amber'] })
  assert.equal(decideDelivery(makeFile(), allow).kind, 'deliver')
  const deny = openPolicy({ mode: 'allowlist', allowlist: ['other-name'] })
  const decision = decideDelivery(makeFile(), deny)
  assert.equal(decision.kind, 'drop')
  if (decision.kind === 'drop') assert.match(decision.reason, /allowlist/)
})

function freshInbox(): string {
  const dir = join(tmpdir(), `crosstalk-deliver-${process.pid}-${Math.random().toString(36).slice(2)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

test('InboxWatcher delivers and consumes accepted messages (wake-on-idle)', () => {
  const clock = new FakeClock()
  const inbox = freshInbox()
  const agent = new FakeAgent('session-1', '/tmp/proj')
  const watcher = new InboxWatcher(inbox, () => [agent.toAgent()], openPolicy())
  writeMessageFile(inbox, makeFile({ id: 'msg-1-aaaa' }))
  writeMessageFile(inbox, makeFile({ id: 'msg-2-bbbb' }))
  watcher.drain()
  assert.equal(agent.followups.length, 2)
  assert.equal(readdirSync(inbox).length, 0)
  const first = agent.followups[0]!
  assert.ok((first.content[0] as { text: string }).text.startsWith('[message from session proj-amber'))
  assert.equal(first.source.kind, 'crosstalk')
  rmSync(inbox, { recursive: true, force: true })
})

test('InboxWatcher ignores tmp files and quarantines corrupt ones', () => {
  const clock = new FakeClock()
  const inbox = freshInbox()
  const agent = new FakeAgent('session-1', '/tmp/proj')
  const watcher = new InboxWatcher(inbox, () => [agent.toAgent()], openPolicy())
  writeFileSync(join(inbox, 'msg-x.json.tmp'), '{"id": "half-')
  writeFileSync(join(inbox, 'msg-broken.json'), '{"id": "broken"') // invalid JSON
  watcher.drain()
  assert.equal(agent.followups.length, 0)
  const files = readdirSync(inbox).sort()
  assert.deepEqual(files, ['msg-broken.json.corrupt', 'msg-x.json.tmp'])
  rmSync(inbox, { recursive: true, force: true })
})

test('InboxWatcher drops policy-rejected messages', () => {
  const clock = new FakeClock()
  const inbox = freshInbox()
  const agent = new FakeAgent('session-1', '/tmp/proj')
  const watcher = new InboxWatcher(inbox, () => [agent.toAgent()], openPolicy({ mode: 'allowlist', allowlist: ['other'] }))
  writeMessageFile(inbox, makeFile())
  watcher.drain()
  assert.equal(agent.followups.length, 0)
  assert.equal(readdirSync(inbox).length, 0)
  rmSync(inbox, { recursive: true, force: true })
})

test('InboxWatcher keeps the file while no agent is live, then drops after maxAttempts', () => {
  const clock = new FakeClock()
  const inbox = freshInbox()
  const watcher = new InboxWatcher(inbox, () => [], openPolicy(), { maxAttempts: 3 })
  writeMessageFile(inbox, makeFile())
  watcher.drain()
  assert.equal(readdirSync(inbox).length, 1) // retained
  watcher.drain()
  assert.equal(readdirSync(inbox).length, 1) // still retained
  watcher.drain()
  assert.equal(readdirSync(inbox).length, 0) // dropped after 3 attempts
  rmSync(inbox, { recursive: true, force: true })
})

test('a live agent appearing later receives the retained file', () => {
  const clock = new FakeClock()
  const inbox = freshInbox()
  const agent = new FakeAgent('session-1', '/tmp/proj')
  let agents: ReturnType<FakeAgent['toAgent']>[] = []
  const watcher = new InboxWatcher(inbox, () => agents, openPolicy(), { maxAttempts: 10 })
  writeMessageFile(inbox, makeFile())
  watcher.drain()
  assert.equal(agent.followups.length, 0)
  agents = [agent.toAgent()]
  watcher.drain()
  assert.equal(agent.followups.length, 1)
  assert.equal(readdirSync(inbox).length, 0)
  rmSync(inbox, { recursive: true, force: true })
})

test('a delivery failure keeps the file for the next poll', () => {
  const clock = new FakeClock()
  const inbox = freshInbox()
  const agent = new FakeAgent('session-1', '/tmp/proj')
  let fail = true
  const toAgent = agent.toAgent()
  const throwing = {
    ...toAgent,
    followup: () => {
      if (fail) throw new Error('boom')
    },
  } as unknown as ReturnType<FakeAgent['toAgent']>
  const watcher = new InboxWatcher(inbox, () => [throwing], openPolicy())
  writeMessageFile(inbox, makeFile())
  watcher.drain()
  assert.equal(readdirSync(inbox).length, 1)
  fail = false
  watcher.drain()
  assert.equal(readdirSync(inbox).length, 0)
  rmSync(inbox, { recursive: true, force: true })
})

test('reentrant drain calls are serialized', () => {
  const clock = new FakeClock()
  const inbox = freshInbox()
  const agent = new FakeAgent('session-1', '/tmp/proj')
  const watcher = new InboxWatcher(inbox, () => {
    watcher.drain() // nested call must be a no-op
    return [agent.toAgent()]
  }, openPolicy())
  writeMessageFile(inbox, makeFile())
  watcher.drain()
  assert.equal(agent.followups.length, 1)
  rmSync(inbox, { recursive: true, force: true })
})
