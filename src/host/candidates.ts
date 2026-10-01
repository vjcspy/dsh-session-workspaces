/**
 * Candidate-label discovery: the closed set of workspaces the classifier may
 * choose from.
 *
 * The set is the directories present under the Aweave `workspaces/` root, plus
 * the configured list. The root is found, not hardcoded: a candidate
 * configuration leaves it empty and this module walks up from the working
 * directories the Sessions report, which keeps the plugin correct on any
 * checkout instead of one Mac path.
 *
 * Discovery touches the filesystem, so it is cached and invalidated by the
 * config epoch — a `loader/volatile-update` (the configured candidate list
 * changed) or a Session arriving with a new working directory is the only thing
 * that re-runs it.
 *
 * @module dsh-session-workspaces/host/candidates
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { WORKSPACES_DIR_NAME } from '../config.ts'

/** How far up from a Session's working directory the workspace root is searched. */
const MAX_SEARCH_DEPTH = 8

/** The filesystem facts discovery needs, injectable so a spec needs no real tree. */
export interface FileSystemLike {
  /** Whether the path is an existing directory. */
  isDirectory(path: string): boolean
  /** The names of the path's child directories, or none when it is unreadable. */
  listDirectories(path: string): readonly string[]
}

/** The real filesystem: a missing or unreadable path yields nothing rather than throwing. */
export const nodeFileSystem: FileSystemLike = {
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  listDirectories: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort()
    } catch {
      return []
    }
  },
}

/**
 * Find the Aweave `workspaces/` root from the working directories in play.
 *
 * Two layouts resolve: a directory NAMED `workspaces` (a Session opened inside
 * the root itself), and a `workspaces` child of an ancestor (the normal case,
 * where Sessions run from the Aweave root).
 * @param workingDirectories - working directories the stored Sessions report.
 * @param fs - filesystem access.
 * @returns the root, or undefined when no candidate directory tree was found.
 */
export function locateWorkspacesRoot(
  workingDirectories: readonly string[],
  fs: FileSystemLike = nodeFileSystem,
): string | undefined {
  for (const start of workingDirectories) {
    if (start.trim() === '') continue
    let current = start
    for (let depth = 0; depth <= MAX_SEARCH_DEPTH; depth += 1) {
      if (basename(current) === WORKSPACES_DIR_NAME && fs.listDirectories(current).length > 0) return current
      const nested = join(current, WORKSPACES_DIR_NAME)
      if (fs.listDirectories(nested).length > 0) return nested
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return undefined
}

/**
 * The candidate set: discovered directory names, plus the configured list.
 *
 * Order is preserved as "discovered (sorted), then configured additions", and
 * duplicates are dropped case-insensitively while the FIRST spelling wins, so a
 * configured alias never produces two rows for one workspace.
 * @param input - the resolved root, configured additions, and filesystem access.
 * @returns the closed candidate list.
 */
export function discoverCandidates(input: {
  readonly root: string | undefined
  readonly configured: readonly string[]
  readonly fs?: FileSystemLike
}): string[] {
  const fs = input.fs ?? nodeFileSystem
  const seen = new Map<string, string>()
  const add = (label: string): void => {
    const trimmed = label.trim()
    if (trimmed === '') return
    const key = trimmed.toLowerCase()
    if (!seen.has(key)) seen.set(key, trimmed)
  }
  if (input.root !== undefined) for (const name of fs.listDirectories(input.root)) add(name)
  for (const label of input.configured) add(label)
  return [...seen.values()]
}

/** Cached discovery, re-run only when the epoch or the working-directory set moves. */
export class CandidateResolver {
  private cache: { readonly epoch: number; readonly key: string; readonly value: string[] } | undefined
  private epoch = 0
  private readonly fs: FileSystemLike

  /**
   * @param fs - filesystem access; defaults to the real one.
   */
  constructor(fs: FileSystemLike = nodeFileSystem) {
    this.fs = fs
  }

  /** Invalidate the cache, because the configuration that feeds it changed. */
  invalidate(): void {
    this.epoch += 1
  }

  /**
   * Resolve the closed candidate set.
   * @param input - configured root, configured additions, and the working directories in play.
   * @returns the candidate labels.
   */
  resolve(input: {
    readonly configuredRoot: string
    readonly configured: readonly string[]
    readonly workingDirectories: readonly string[]
  }): string[] {
    const key = JSON.stringify([input.configuredRoot, input.configured, input.workingDirectories])
    if (this.cache !== undefined && this.cache.epoch === this.epoch && this.cache.key === key) return this.cache.value
    const root = input.configuredRoot.trim() !== ''
      ? input.configuredRoot.trim()
      : locateWorkspacesRoot(input.workingDirectories, this.fs)
    const value = discoverCandidates({ root, configured: input.configured, fs: this.fs })
    this.cache = { epoch: this.epoch, key, value }
    return value
  }
}
