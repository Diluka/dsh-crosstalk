/**
 * Shared test helpers: a controllable clock and a minimal fake Agent that
 * records `followup` deliveries, standing in for the live session the inbox
 * watcher wakes.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** A mutable clock for deterministic heartbeat/staleness tests. */
export class FakeClock {
  private value: number
  constructor(start = 1_000_000) {
    this.value = start
  }
  now(): number {
    return this.value
  }
  advance(ms: number): void {
    this.value += ms
  }
}

/** A minimal live-agent double recording every delivered follow-up. */
export class FakeAgent {
  readonly followups: UserMessage[] = []
  status: 'idle' | 'running' = 'idle'
  readonly id: string
  readonly cwd: string

  constructor(id: string, cwd: string) {
    this.id = id
    this.cwd = cwd
  }

  followup(message: UserMessage): void {
    this.followups.push(message)
  }

  /** The Agent-shaped view the runtime consumes. */
  toAgent(): Agent {
    return {
      id: this.id as Agent['id'],
      status: this.status as Agent['status'],
      session: { header: { cwd: this.cwd } } as Agent['session'],
      followup: (message: UserMessage) => this.followup(message),
    } as unknown as Agent
  }
}
