import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { applyToolDecoration, buildListAgents, buildSendMessage } from '../src/tools.ts'
import type { CrosstalkService } from '../src/types.ts'

/** A stock-like tool to stand in for `dsh-tool-subagent-control`'s registrations. */
function stockTool(name: string, marker: string): ToolDefinition {
  return defineTool({
    name,
    description: `stock ${name}`,
    parameters: {
      scope: { type: 'string', enum: ['children', 'descendants'], description: 'stock scopes' },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: ['child'] },
            id: { type: 'string', required: true },
            label: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['running', 'idle', 'ready'] },
          },
        },
      },
      render: (_args: unknown, _value: unknown) => [{ type: 'text', text: `${marker}:render` }],
    },
    execute: async (args: { scope?: string }) => [{ kind: 'child', id: `stock-${marker}-${args.scope}`, label: marker, status: 'idle' }],
  })
}

/** A minimal no-op service for the decoration test. */
const noopService: CrosstalkService = {
  self() { throw new Error('unused') },
  peers() { return [] },
  send() { throw new Error('unused') },
  resolve() { return { kind: 'unknown' } },
}

test('scoped shadows override the stock tools per agent and restore them on dispose', async () => {
  const ctx = new Context()
  new SystemPrompt(ctx, {}) // required by ToolRuntime's constructor
  new ToolRuntime(ctx)      // provides ctx.tools
  ctx.provide('agents', { list: () => [] } as never) // applyToolDecoration lists live agents

  // Stock registrations (what the harness preset mounts).
  ctx.tools.register(stockTool('list_agents', 'stock'))
  ctx.tools.register(stockTool('send_message', 'stock'))

  // An agent-like scope, standing in for agent.ctx.
  const scope = createScope(ctx, Symbol('agent'))
  const agentCtx = scope.ctx

  // The agent view inherits the stock tools (resolved by the agent's scope,
  // exactly as the harness views them).
  const scopeKey = scopeOf(agentCtx)
  const inheritedList = agentCtx.tools.get('list_agents', scopeKey)
  assert.ok(inheritedList, 'agent must inherit the stock list_agents')
  assert.equal(inheritedList!.output.render({ scope: 'children' }, [] as never)[0]!.type, 'text')

  // Decorate this one agent (the listener path is exercised through applyToolDecoration).
  const decoration = applyToolDecoration(ctx, noopService)
  // applyToolDecoration decorates ctx.agents.list() — no agents are registered on
  // a bare context, so register the shadow directly to test the mechanism.
  const stock = agentCtx.tools.get('list_agents', scopeKey)!
  const sendStock = agentCtx.tools.get('send_message', scopeKey)!
  const listShadow = buildListAgents(noopService, stock)
  const sendShadow = buildSendMessage(noopService, sendStock)
  agentCtx.tools.register(listShadow)
  agentCtx.tools.register(sendShadow)

  // Inside the agent scope the shadow resolves (peers scope is new); the
  // global view still sees the stock definition.
  const shadow = agentCtx.tools.get('list_agents', scopeKey)!
  assert.notEqual(shadow, inheritedList)
  const globalView = ctx.tools.get('list_agents')
  assert.equal(globalView, inheritedList)

  // Stock scopes delegate to the captured stock definition.
  const stockRows = (await shadow.execute({ scope: 'children' }, { agent: undefined, signal: new AbortController().signal } as never)) as Array<{ id: string }>
  assert.equal(stockRows[0]!.id, 'stock-stock-children')

  // Peers scope works without any stock subagent machinery.
  const peerRows = await shadow.execute({ scope: 'peers' }, { agent: undefined, signal: new AbortController().signal } as never)
  assert.deepEqual(peerRows, [])

  // Unloading the scope restores stock behavior exactly.
  await scope.dispose()
  assert.equal(agentCtx.tools.get('list_agents', scopeKey), inheritedList)
  decoration()
})

test('applyToolDecoration is a no-op without registered agents and disposes cleanly', () => {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  ctx.provide('agents', { list: () => [] } as never)
  const decoration = applyToolDecoration(ctx, noopService)
  assert.doesNotThrow(() => decoration())
})
