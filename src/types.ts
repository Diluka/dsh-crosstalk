/**
 * dsh-crosstalk — shared domain types.
 *
 * A session is a live DSH process participating in cross-session messaging. It
 * publishes one heartbeat JSON file under `<homeDir>/registry/<ref>.json` and
 * receives messages through its inbox directory
 * `<homeDir>/inbox/<ref>/`. Messages are one JSON file per message, written
 * atomically (temp file + rename) so a crash mid-write is never observed as a
 * partial message.
 *
 * @module @dsh-crosstalk/bundle/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Peer lifecycle status, mirroring `list_agents` vocabulary. */
export type PeerStatus = 'running' | 'idle' | 'ready'

/** How a session may be addressed in `send_message to:`. */
export type PeerAddress = { kind: 'name'; name: string } | { kind: 'ref'; ref: string }

/** One live (or stale-but-not-yet-collected) session entry on this machine. */
export interface PeerInfo {
  /** Stable human-readable name: `<repo-or-cwd-slug>-<adjective>`. */
  name: string
  /** Durable per-process ref id used for inbox addressing. */
  ref: string
  /** OS pid of the session process. */
  pid: number
  /** Absolute working directory the session runs in. */
  cwd: string
  /** `running` while any root agent is active, `idle` otherwise, `ready` when no live agent exists. */
  status: PeerStatus
  /** Epoch ms when the session started. */
  startedAt: number
  /** Epoch ms of the last heartbeat write. */
  heartbeatAt: number
  /** OS user id of the session process (undefined where the platform does not report one). */
  uid?: number
}

/** The identity of this process's own session. */
export interface SelfIdentity extends PeerInfo {
  /** Absolute path of this session's inbox directory. */
  inbox: string
}

/**
 * The sender block riding on every message. The sender's name/ref make reply
 * addressing free — the receiver just `send_message`s back to the name.
 */
export interface MessageSender {
  name: string
  ref: string
  cwd: string
  /** The sending session's root agent id, for provenance. */
  sessionId?: string
  uid?: number
}

/** One message file as written to the target's inbox. */
export interface MessageFile {
  /** Stable message id (also the file basename). */
  id: string
  /** Epoch ms when the sender wrote the message. */
  sentAt: number
  from: MessageSender
  /** Optional 5–10 word recap shown in the target's UI. */
  summary?: string
  /** The message body. */
  text: string
}

/** Outcome of resolving a peer address. */
export type PeerResolution =
  | { kind: 'live'; peer: PeerInfo }
  | { kind: 'stale'; peer: PeerInfo }
  | { kind: 'unknown' }

/** Inbound delivery decision after the trust policy runs. */
export type DeliveryDecision =
  | { kind: 'deliver' }
  | { kind: 'drop'; reason: string }

/**
 * The durable provenance of a cross-session message injected into a session.
 * Rendered by the DSH UI as a labeled `relay` card (`notifyUser`) or as a
 * collapsed `notice` row — never as user text.
 */
export interface CrosstalkMessageSource {
  readonly kind: 'crosstalk'
  /** `relay` shows a prominent "From session …" card; `notice` collapses to a summary line. */
  readonly form: 'relay' | 'notice'
  /** Session id of the sending session's root agent. */
  readonly senderSessionId?: SessionId
  /** One-line account for the `notice` form. */
  readonly summary?: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    crosstalk: CrosstalkMessageSource
  }
}

/** The `crosstalk` service exposed on the context that installed the bundle. */
export interface CrosstalkService {
  /** This process's own session identity. */
  self(): SelfIdentity
  /** Live peer sessions on this machine, excluding self, in name order. */
  peers(): PeerInfo[]
  /**
   * Send one message to a peer session, addressed by name or ref.
   * @param to - peer name or ref (as shown by `list_agents peers`).
   * @param input - message text and optional summary.
   * @returns the message id and the resolved recipient.
   * @throws when the address is unknown, stale, or not same-user.
   */
  send(to: string, input: { text: string; summary?: string }): Promise<{ messageId: string; to: PeerInfo }>
  /** Resolve a peer address without sending. */
  resolve(to: string): PeerResolution
}
