import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  crosstalkSource,
  frameLabel,
  frameText,
  mintMessageId,
  parseMessageFile,
  readMessageFile,
  serializeMessageFile,
  toUserMessage,
  writeMessageFile,
} from '../src/message.ts'
import type { MessageFile, MessageSender } from '../src/types.ts'
import { FakeClock } from './helpers.ts'

const SENDER: MessageSender = { name: 'proj-amber', ref: 'ct-aaaa', cwd: '/tmp/proj', sessionId: 'session-1' }

function makeFile(overrides: Partial<MessageFile> = {}): MessageFile {
  return {
    id: 'msg-1-abcdef',
    sentAt: 1000,
    from: SENDER,
    text: 'hello peer',
    ...overrides,
  }
}

test('frameLabel is the exact spec label', () => {
  assert.equal(frameLabel(SENDER), '[message from session proj-amber (/tmp/proj)]')
})

test('frameText labels the message and carries an optional summary', () => {
  const plain = frameText(SENDER, 'hello peer')
  assert.ok(plain.startsWith('[message from session proj-amber (/tmp/proj)]\n\nhello peer'))
  const withSummary = frameText(SENDER, 'hello peer', 'quick ping about the deploy')
  assert.ok(withSummary.includes('\nSummary: quick ping about the deploy\n\n'))
})

test('serialize/parse round-trips every field and tolerates junk', () => {
  const file = makeFile({ summary: 'quick ping', sentAt: 42 })
  const parsed = parseMessageFile(JSON.parse(serializeMessageFile(file)))
  assert.deepEqual(parsed, file)
  assert.equal(parseMessageFile(null), undefined)
  assert.equal(parseMessageFile({ id: 'x' }), undefined)
  assert.equal(parseMessageFile({ id: 'x', sentAt: 1, from: { name: 'a' }, text: 't' }), undefined)
})

test('writeMessageFile writes the final name only; tmp files are never final', () => {
  const clock = new FakeClock()
  const inbox = join(tmpdir(), `crosstalk-inbox-${process.pid}-${Math.random().toString(36).slice(2)}`)
  rmSync(inbox, { recursive: true, force: true })
  const path = writeMessageFile(inbox, makeFile({ id: 'msg-9-aaaa', sentAt: clock.now() }))
  assert.ok(existsSync(path))
  // Simulate a crash mid-write: a .tmp file is left behind and ignored.
  writeFileSync(join(inbox, 'msg-9-aaaa.json.tmp'), '{"id": "half-')
  const files = readdirSync(inbox).sort()
  assert.deepEqual(files, ['msg-9-aaaa.json', 'msg-9-aaaa.json.tmp'])
  const read = readMessageFile(path)
  assert.ok(read)
  assert.equal(read!.id, 'msg-9-aaaa')
  rmSync(inbox, { recursive: true, force: true })
})

test('toUserMessage frames the turn with a crosstalk relay source (notifyUser)', () => {
  const message = toUserMessage(makeFile({ summary: 'quick ping' }), true)
  assert.equal(message.role, 'user')
  assert.equal(message.content[0]!.type, 'text')
  const text = (message.content[0] as { type: 'text'; text: string }).text
  assert.ok(text.startsWith('[message from session proj-amber (/tmp/proj)]'))
  assert.ok(text.includes('Summary: quick ping'))
  assert.equal(message.source.kind, 'crosstalk')
  assert.equal((message.source as { form: string }).form, 'relay')
  assert.equal((message.source as { senderSessionId?: string }).senderSessionId, 'session-1')
})

test('toUserMessage collapses to a notice summary when notifyUser is off', () => {
  const message = toUserMessage(makeFile(), false)
  const source = message.source as { form: string; summary?: string }
  assert.equal(source.form, 'notice')
  assert.equal(source.summary, 'Message from session proj-amber')
})

test('mintMessageId is unique and readable', () => {
  const clock = new FakeClock()
  const a = mintMessageId(clock.now.bind(clock))
  const b = mintMessageId(clock.now.bind(clock))
  assert.notEqual(a, b)
  assert.match(a, /^msg-\d+-[0-9a-f]+$/)
})
