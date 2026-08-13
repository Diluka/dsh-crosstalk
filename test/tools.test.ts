import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildListAgents, buildSendMessage, projectPeer } from '../src/tools.ts'
import type { CrosstalkService, PeerInfo, PeerResolution, SelfIdentity } from '../src/types.ts'

/** A stub CrosstalkService for tool tests. */
class FakeService implements CrosstalkService {
  peersValue: PeerInfo[] = []
  resolutions = new Map<string, PeerResolution>()
  sent: Array<{ to: string; input: { text: string; summary?: string } }> = []

  self(): SelfIdentity {
    throw new Error('not used in these tests')
  }
  peers(): PeerInfo[] {
    return this.peersValue
  }
  resolve(to: string): PeerResolution {
    return this.resolutions.get(to) ?? { kind: 'unknown' }
  }
  async send(to: string, input: { text: string; summary?: string }): Promise<{ messageId: string; to: PeerInfo }> {
    this.sent.push({ to, input })
    return { messageId: `msg-${this.sent.length}`, to: this.peersValue[0]! }
  }
}

/** A stub stock tool recording delegated calls. */
class FakeStock {
  calls: Array<{ args: unknown }> = []
  result: unknown = [{ kind: 'child', id: 'session-child', label: 'child', status: 'idle' }]

  execute(args: unknown, _exec: ToolRunContext): Promise<unknown> {
    this.calls.push({ args })
    return Promise.resolve(this.result)
  }
  output = {
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: `stock-render:${JSON.stringify(value)}` }],
  }
}

function execStub(): ToolRunContext {
  return { agent: undefined, signal: new AbortController().signal } as unknown as ToolRunContext
}

const PEER: PeerInfo = {
  name: 'peer-amber',
  ref: 'ct-peer',
  pid: 42,
  cwd: '/tmp/peer',
  status: 'idle',
  startedAt: 100,
  heartbeatAt: 200,
  uid: 501,
}

test('projectPeer projects registry rows onto list_agents rows', () => {
  assert.deepEqual(projectPeer(PEER), {
    kind: 'peer',
    name: 'peer-amber',
    ref: 'ct-peer',
    status: 'idle',
    cwd: '/tmp/peer',
    lastActivity: 200,
  })
})

test('list_agents peers scope returns peer rows from the service', async () => {
  const service = new FakeService()
  service.peersValue = [PEER]
  const tool = buildListAgents(service, undefined) as ToolDefinition
  const rows = (await tool.execute({ scope: 'peers' }, execStub())) as Array<{ kind: string; name: string }>
  assert.deepEqual(rows, [{ kind: 'peer', name: 'peer-amber', ref: 'ct-peer', status: 'idle', cwd: '/tmp/peer', lastActivity: 200 }])
  const rendered = tool.output.render({ scope: 'peers' }, rows)
  assert.equal(rendered[0]!.type, 'text')
  assert.match((rendered[0] as { text: string }).text, /peer-amber \[idle\] — \/tmp\/peer/)
})

test('list_agents delegates children/descendants to the stock tool', async () => {
  const service = new FakeService()
  const stock = new FakeStock()
  const tool = buildListAgents(service, stock as unknown as ToolDefinition) as ToolDefinition
  const children = await tool.execute({ scope: 'children' }, execStub())
  assert.deepEqual(stock.calls[0]!.args, { scope: 'children' })
  assert.deepEqual(children, stock.result)
  await tool.execute({ scope: 'descendants' }, execStub())
  assert.deepEqual(stock.calls[1]!.args, { scope: 'descendants' })
})

test('list_agents all combines descendants with peers', async () => {
  const service = new FakeService()
  service.peersValue = [PEER]
  const stock = new FakeStock()
  stock.result = [{ kind: 'child', id: 'session-child', label: 'child', status: 'idle', parent: 'session-parent', depth: 1 }]
  const tool = buildListAgents(service, stock as unknown as ToolDefinition) as ToolDefinition
  const rows = (await tool.execute({ scope: 'all' }, execStub())) as Array<{ kind: string }>
  assert.deepEqual(rows.map((r) => r.kind), ['child', 'peer'])
  const rendered = tool.output.render({ scope: 'all' }, rows)
  assert.match((rendered[0] as { text: string }).text, /session-child \[idle\]/)
  assert.match((rendered[0] as { text: string }).text, /peer-amber \[idle\]/)
})

test('list_agents without stock fails loudly for stock scopes but works for peers', async () => {
  const service = new FakeService()
  service.peersValue = [PEER]
  const tool = buildListAgents(service, undefined) as ToolDefinition
  await assert.rejects(() => tool.execute({ scope: 'children' }, execStub()), /stock subagent tooling/)
  const rows = await tool.execute({ scope: 'peers' }, execStub())
  assert.equal((rows as unknown[]).length, 1)
})

test('send_message peer path sends through the service', async () => {
  const service = new FakeService()
  service.resolutions.set('peer-amber', { kind: 'live', peer: PEER })
  const tool = buildSendMessage(service, undefined) as ToolDefinition
  const result = (await tool.execute({ to: 'peer-amber', message: 'hi', summary: 'quick ping' }, execStub())) as { messageId: string }
  assert.match(result.messageId, /^msg-/)
  assert.deepEqual(service.sent, [{ to: 'peer-amber', input: { text: 'hi', summary: 'quick ping' } }])
})

test('send_message falls back to the stock tool for unknown addresses (subagent ids)', async () => {
  const service = new FakeService()
  const stock = new FakeStock()
  stock.result = { messageId: 'stock-message-id' }
  const tool = buildSendMessage(service, stock as unknown as ToolDefinition) as ToolDefinition
  const result = await tool.execute({ to: 'session-child', message: 'continue' }, execStub())
  assert.deepEqual(result, { messageId: 'stock-message-id' })
  assert.deepEqual(stock.calls[0]!.args, { subagent_id: 'session-child', message: 'continue' })
})

test('send_message rejects stale peers with a clear error', async () => {
  const service = new FakeService()
  service.resolutions.set('dead-peer', { kind: 'stale', peer: { ...PEER, name: 'dead-peer', heartbeatAt: 1 } })
  const tool = buildSendMessage(service, undefined as unknown as ToolDefinition) as ToolDefinition
  await assert.rejects(() => tool.execute({ to: 'dead-peer', message: 'hi' }, execStub()), /not currently live/)
})

test('send_message without stock and unknown address fails loudly', async () => {
  const service = new FakeService()
  const tool = buildSendMessage(service, undefined) as ToolDefinition
  await assert.rejects(() => tool.execute({ to: 'nope', message: 'hi' }, execStub()), /no peer session named "nope"/)
})

test('tool render stays a pure projection (no context access)', () => {
  const service = new FakeService()
  service.peersValue = [PEER]
  const tool = buildListAgents(service, undefined) as ToolDefinition
  const ctx = {} as Context
  assert.doesNotThrow(() => tool.output.render({ scope: 'peers' }, [projectPeer(PEER)]))
  void ctx
})
