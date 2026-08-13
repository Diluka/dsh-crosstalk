/**
 * Small filesystem helpers shared by the registry and the message codec:
 * atomic JSON writes (temp file + rename — a crash mid-write leaves a `.tmp`
 * that consumers ignore) and tolerant JSON reads.
 *
 * @module @dsh-crosstalk/bundle/atomic
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Ensure a directory exists (recursive, idempotent). */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/**
 * Write `data` to `path` atomically: write to `<path>.tmp` in the same
 * directory, then rename over the destination. A reader that only looks at
 * final names never observes a partial write, and the rename is atomic on
 * POSIX filesystems.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

/** Write a JSON value atomically with a trailing newline. */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Read and parse a JSON file, returning `undefined` when the file is missing
 * or unreadable (a concurrently-removed heartbeat or message is normal).
 * Malformed JSON yields `undefined` too — the caller decides whether to
 * quarantine the source file.
 */
export function readJsonFile(path: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Unlink one file, ignoring absence. */
export function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // absent or already gone
  }
}
