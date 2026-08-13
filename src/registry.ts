/**
 * The local session registry: one JSON heartbeat file per live session under
 * `<homeDir>/registry/<ref>.json`, refreshed on a timer, garbage-collected
 * when stale. Files + atomic rename — no daemon. If two sessions can see the
 * same home directory, they can message.
 *
 * @module @dsh-crosstalk/bundle/registry
 */

import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile, unlinkQuiet, writeJsonAtomic } from './atomic.ts'
import type { PeerAddress, PeerInfo, PeerResolution, SelfIdentity } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Validate one parsed heartbeat file into a PeerInfo, or undefined when corrupt. */
export function parseHeartbeat(value: unknown): PeerInfo | undefined {
  if (!isRecord(value)) return undefined
  const name = asString(value.name)
  const ref = asString(value.ref)
  const pid = asNumber(value.pid)
  const cwd = asString(value.cwd)
  const status = value.status
  const startedAt = asNumber(value.startedAt)
  const heartbeatAt = asNumber(value.heartbeatAt)
  if (
    name === undefined || ref === undefined || pid === undefined || cwd === undefined ||
    (status !== 'running' && status !== 'idle' && status !== 'ready') ||
    startedAt === undefined || heartbeatAt === undefined
  ) return undefined
  const uid = asNumber(value.uid)
  return { name, ref, pid, cwd, status, startedAt, heartbeatAt, ...(uid === undefined ? {} : { uid }) }
}

/**
 * Owns the registry directory: writes this process's heartbeat, lists and
 * resolves peers, and garbage-collects stale entries.
 */
export class HeartbeatRegistry {
  private readonly homeDir: string
  private readonly now: () => number

  constructor(homeDir: string, now: () => number) {
    this.homeDir = homeDir
    this.now = now
  }

  /** `<homeDir>/registry`. */
  registryDir(): string {
    return join(this.homeDir, 'registry')
  }

  /** `<homeDir>/inbox/<ref>`. */
  inboxDirFor(ref: string): string {
    return join(this.homeDir, 'inbox', ref)
  }

  /** Write (or refresh) one session's heartbeat, atomically. */
  writeHeartbeat(self: SelfIdentity): void {
    const { inbox: _inbox, ...peer } = self
    writeJsonAtomic(join(this.registryDir(), `${self.ref}.json`), peer)
  }

  /** Remove this session's heartbeat (clean shutdown). */
  removeHeartbeat(ref: string): void {
    unlinkQuiet(join(this.registryDir(), `${ref}.json`))
  }

  /** Read one registry entry by ref. */
  readEntry(ref: string): PeerInfo | undefined {
    return parseHeartbeat(readJsonFile(join(this.registryDir(), `${ref}.json`)))
  }

  /**
   * Every registry entry (fresh or stale), sorted by name. Stale entries are
   * garbage-collected on the way out: the heartbeat file is removed, and the
   * ref's inbox directory is removed when nothing references it anymore.
   * @param staleAfterMs - age at which an entry is considered dead.
   * @returns fresh entries only, never self (the caller filters by ref).
   */
  list(staleAfterMs: number, excludeRef?: string): PeerInfo[] {
    const now = this.now()
    const fresh: PeerInfo[] = []
    let files: string[]
    try {
      files = readdirSync(this.registryDir())
    } catch {
      return fresh
    }
    for (const file of files) {
      if (!file.endsWith('.json') || file.endsWith('.tmp.json')) continue
      const ref = file.slice(0, -'.json'.length)
      if (ref === excludeRef) continue
      const entry = parseHeartbeat(readJsonFile(join(this.registryDir(), file)))
      if (entry === undefined) {
        unlinkQuiet(join(this.registryDir(), file))
        continue
      }
      if (now - entry.heartbeatAt > staleAfterMs) {
        unlinkQuiet(join(this.registryDir(), file))
        continue
      }
      fresh.push(entry)
    }
    return fresh.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Resolve a peer address (name or ref) against the live registry.
   * @returns `live` for fresh entries, `stale` for entries past the
   *   staleness window (still resolvable for diagnostics), `unknown` for
   *   anything else. Deliberately does NOT garbage-collect, so a stale entry
   *   is still reported as stale rather than vanishing into `unknown`; the
   *   collectors run from {@link list} and the heartbeat tick.
   */
  resolve(address: PeerAddress, staleAfterMs: number, selfRef?: string): PeerResolution {
    const now = this.now()
    const entry = address.kind === 'ref'
      ? this.readEntry(address.ref)
      : this.allEntries().find((peer) => peer.name === address.name)
    if (entry === undefined || entry.ref === selfRef) return { kind: 'unknown' }
    if (now - entry.heartbeatAt > staleAfterMs) return { kind: 'stale', peer: entry }
    return { kind: 'live', peer: entry }
  }

  /** Every readable registry entry (fresh or stale), unsorted. */
  private allEntries(): PeerInfo[] {
    let files: string[]
    try {
      files = readdirSync(this.registryDir())
    } catch {
      return []
    }
    const entries: PeerInfo[] = []
    for (const file of files) {
      if (!file.endsWith('.json') || file.endsWith('.tmp.json')) continue
      const entry = parseHeartbeat(readJsonFile(join(this.registryDir(), file)))
      if (entry !== undefined) entries.push(entry)
    }
    return entries
  }

  /**
   * Remove inbox directories whose ref no longer has a registry file at all
   * (the owning session ended and its heartbeat was removed or expired).
   * Runs as part of {@link list}; exported for tests.
   */
  collectOrphanInboxes(): void {
    const registry = new Set(this.allEntries().map((entry) => entry.ref))
    let refs: string[]
    try {
      refs = readdirSync(join(this.homeDir, 'inbox'))
    } catch {
      return
    }
    for (const ref of refs) {
      if (registry.has(ref)) continue
      try {
        rmSync(join(this.homeDir, 'inbox', ref), { recursive: true, force: true })
      } catch {
        // race with a concurrent writer; ignore
      }
    }
  }
}
