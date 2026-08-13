/**
 * Session identity for dsh-crosstalk: the stable human-readable name
 * (`<repo-or-cwd-slug>-<adjective>`) and the durable ref id that
 * disambiguates collisions between sessions that share a cwd.
 *
 * Both are derived deterministically from the session's cwd plus its
 * process-unique ref, so a name never changes during a session's lifetime,
 * two sessions in the same directory get different adjectives, and a restarted
 * session gets a fresh ref (old heartbeats go stale and are garbage-collected).
 *
 * @module @dsh-crosstalk/bundle/identity
 */

import { createHash, randomBytes } from 'node:crypto'

/** A stable, machine-readable session name: `[a-z0-9][a-z0-9-]*`. */
export type SessionName = string

/** The durable per-process ref id: `ct-` plus hex, used in `to` and inbox paths. */
export type SessionRef = string

/**
 * Adjective pool for session names. Sorted so a hash picks a stable word; the
 * pool is deliberately larger than one-per-repo so same-cwd sessions diverge.
 */
export const ADJECTIVES: readonly string[] = [
  'amber', 'azure', 'beige', 'bronze', 'carmine', 'cerulean', 'charcoal',
  'cobalt', 'coral', 'crimson', 'cyan', 'emerald', 'garnet', 'gold',
  'indigo', 'ivory', 'jade', 'lavender', 'lilac', 'magenta', 'maroon',
  'mauve', 'mint', 'navy', 'ochre', 'olive', 'peach', 'periwinkle', 'plum',
  'pomegranate', 'rose', 'ruby', 'sapphire', 'scarlet', 'sepia', 'silver',
  'slate', 'teal', 'terracotta', 'turquoise', 'ultramarine', 'vermilion',
  'violet', 'viridian', 'walnut', 'wheat', 'wisteria', 'zaffre',
] as const

/** Hard cap on a session name's total length (slug + '-' + adjective). */
export const MAX_NAME_LENGTH = 48

/** Hard cap on the slug portion (the adjective rides after it). */
export const MAX_SLUG_LENGTH = 32

/** Maximum length of a ref id (the `ct-` prefix plus hex). */
export const MAX_REF_LENGTH = 16

/**
 * Slugify a directory name into a stable `[a-z0-9-]` token: lowercase,
 * collapse non-alphanumeric runs to single dashes, trim dashes.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
  return slug === '' ? 'root' : slug
}

/** The repo-or-cwd slug for a session working directory. */
export function cwdSlug(cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, '')
  const name = base.slice(base.lastIndexOf('/') + 1)
  return slugify(name)
}

/** Stable FNV-1a hash over a string, returned as an unsigned 32-bit int. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Pick the adjective for a session: deterministic over (cwd, ref) so the name
 * is stable for the session's lifetime and distinct between same-cwd sessions.
 */
export function adjectiveFor(cwd: string, ref: string): string {
  const index = fnv1a(`${cwd}\u0000${ref}`) % ADJECTIVES.length
  return ADJECTIVES[index] ?? 'amber'
}

/**
 * Compose the full session name: `<slug>-<adjective>` (truncated to
 * {@link MAX_NAME_LENGTH}).
 */
export function sessionName(cwd: string, ref: string): SessionName {
  const slug = cwdSlug(cwd)
  const adjective = adjectiveFor(cwd, ref)
  const full = `${slug}-${adjective}`
  return full.length <= MAX_NAME_LENGTH ? full : full.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, '')
}

/**
 * Mint the durable per-process ref id. Unique across processes on one machine
 * (pid + start time + entropy), stable for the lifetime of the process, and
 * short enough to type into `send_message to:`.
 */
export function mintRef(cwd: string, pid: number, startedAt: number, entropy = randomBytes(4).toString('hex')): SessionRef {
  const digest = createHash('sha256')
    .update(cwd)
    .update('\u0000')
    .update(String(pid))
    .update('\u0000')
    .update(String(startedAt))
    .update('\u0000')
    .update(entropy)
    .digest('hex')
  return `ct-${digest.slice(0, MAX_REF_LENGTH - 3)}`
}

/** The current OS user id, when the platform reports one (undefined on Windows). */
export function currentUid(): number | undefined {
  const uid = process.getuid?.()
  return typeof uid === 'number' && Number.isSafeInteger(uid) ? uid : undefined
}

/** A `[a-z0-9][a-z0-9-]*` token; used to sanity-check names from config. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** A `ct-` + hex ref token, as minted by {@link mintRef}. */
export const REF_PATTERN = /^ct-[0-9a-f]{6,}$/
