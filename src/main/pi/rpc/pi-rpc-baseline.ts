// Pi binary version baseline (SNC1.9 native Pi).
//
// Adapted from 44madfire/orca-pi `packages/pi-rpc/src/baseline.ts` (MIT).
// Orca-side adaptation: version probing runs through Orca's single
// child-process chokepoint (`runProcess`) instead of `node:child_process`
// `execFile`, which the import-boundary ratchet forbids outside
// `src/shared/child-process/`. Secret-free like the original: only the
// version number, platform, and framing constant are collected.

import { runProcess } from '../../../shared/child-process/run-process'

export type BaselineModelSummary = {
  provider: string
  id: string
  reasoning: boolean
  supportsImages: boolean
}

export type PiBaseline = {
  /** Raw `pi --version` output trimmed (e.g. "0.84.4"). */
  piVersion: string
  /** `process.platform` of the capturing host. */
  platform: string
  /** Node version used to drive the capture. */
  nodeVersion: string
  /** UTC ISO timestamp of capture. */
  capturedAt: string
  /** Number of models in the live catalog (offline runs report 0). */
  modelCount: number
  /** Redacted model summaries (no costs/urls/tokens). */
  models: BaselineModelSummary[]
  /** Thinking levels observed for the default model. */
  thinkingLevels: string[]
  /** RPC framing contract (constant; asserted by tests + fixtures). */
  framing: 'LF-only'
  /** Commands exercised by the fixture set. */
  commandsCovered: string[]
  /** Events observed on stdout during capture. */
  eventsObserved: string[]
}

async function runPiVersion(piCommand: string): Promise<string> {
  const result = await runProcess({ program: piCommand, args: ['--version'], timeoutMs: 15_000 })
  const out = `${result.stdout}\n${result.stderr}`.trim()
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(out)
  if (result.code !== 0 && !match) {
    throw new Error(`pi --version failed (code=${String(result.code)})`)
  }
  return match?.[1] ?? out
}

export async function collectBaseline(piCommand = 'pi'): Promise<PiBaseline> {
  const piVersion = await runPiVersion(piCommand)
  return {
    piVersion,
    platform: process.platform,
    nodeVersion: process.version,
    capturedAt: new Date().toISOString(),
    modelCount: -1,
    models: [],
    thinkingLevels: [],
    framing: 'LF-only',
    commandsCovered: [],
    eventsObserved: []
  }
}

/** Shape guard for a collected baseline record. */
export function isPiBaseline(value: unknown): value is PiBaseline {
  if (!value || typeof value !== 'object') {
    return false
  }
  const v = value as Record<string, unknown>
  return (
    typeof v['piVersion'] === 'string' &&
    typeof v['platform'] === 'string' &&
    typeof v['framing'] === 'string' &&
    Array.isArray(v['models'])
  )
}
