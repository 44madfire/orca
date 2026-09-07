import { describe, expect, it, vi } from 'vitest'
import {
  runHostedHostOriginSourceControlStep,
  verifyHostedHostOriginSourceControlJourney
} from '../../scripts/hosted-ios-host-origin-source-control-journey.mjs'

const tapByLabelPrefix = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/hosted-ios-emulator-accessibility.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tapHostedIosAccessibilityControlByLabelPrefix: tapByLabelPrefix
}))

const CHANGED_FILE = 'mobile/src/mobile-web/bridge.ts'
const CHANGED_FILE_LABEL = `Open changed file ${CHANGED_FILE}`

function journeyOperations(labels: string[]) {
  const sourceControl = {
    href: 'orca-mobile-web://build/h/host/source-control/workspace'
  }
  const review = { href: 'orca-mobile-web://build/h/host/review/workspace' }
  const returnedWorkspace = { href: 'orca-mobile-web://build/' }
  const activate = vi.fn().mockResolvedValue(undefined)
  const longPress = vi.fn().mockResolvedValue(undefined)
  const tapNative = vi.fn().mockResolvedValue(undefined)
  const waitForDocument = vi
    .fn()
    .mockResolvedValueOnce(sourceControl)
    .mockResolvedValueOnce(review)
    .mockResolvedValueOnce(sourceControl)
    .mockResolvedValueOnce(sourceControl)
    .mockResolvedValueOnce(returnedWorkspace)
  const readState = vi
    .fn()
    .mockResolvedValueOnce({ href: sourceControl.href, labels })
    .mockResolvedValueOnce({ href: review.href, labels: ['Show all review files'] })
    .mockResolvedValueOnce({ href: review.href, labels: ['Back', 'Open review actions'] })
  return {
    documents: { returnedWorkspace, review, sourceControl },
    operations: { activate, longPress, readState, tapNative, waitForDocument }
  }
}

describe('hosted iOS host-origin Source Control journey', () => {
  it.each([
    ['native baseline', { changedFileLabel: CHANGED_FILE_LABEL }, undefined],
    ['fixture changed file', null, CHANGED_FILE]
  ])('opens mobile Review from the %s oracle', async (_name, nativeBaseline, changedFilePath) => {
    const { documents, operations } = journeyOperations([
      'Refresh source control',
      CHANGED_FILE_LABEL
    ])

    const result = await verifyHostedHostOriginSourceControlJourney({
      changedFilePath,
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { udid: 'SIMULATOR-1' },
      nativeBaseline,
      timeoutMs: 30_000,
      workspaceName: 'mobile-rearch',
      operations
    })

    expect(operations.longPress).toHaveBeenCalledWith(
      { udid: 'SIMULATOR-1' },
      'mobile-rearch',
      30_000,
      undefined,
      'Source Control'
    )
    expect(operations.tapNative).toHaveBeenCalledWith(
      { udid: 'SIMULATOR-1' },
      'Source Control',
      30_000
    )
    expect(operations.activate.mock.calls.map((call) => call[1])).toEqual([
      { kind: 'label', value: CHANGED_FILE_LABEL },
      { kind: 'label', value: 'Back' },
      { kind: 'label', value: 'Back to session' }
    ])
    expect(operations.waitForDocument).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedHrefIncludes: '/review/' })
    )
    expect(operations.waitForDocument).toHaveBeenCalledTimes(5)
    expect(result).toMatchObject({
      changedFileLabel: CHANGED_FILE_LABEL,
      reviewRoute: documents.review.href,
      sourceControlRoute: documents.sourceControl.href,
      workspaceDocument: documents.returnedWorkspace
    })
  })

  it('fails when the fixture changed file is absent from Source Control', async () => {
    const { operations } = journeyOperations([
      'Refresh source control',
      'Open changed file mobile/app/index.tsx'
    ])

    await expect(
      verifyHostedHostOriginSourceControlJourney({
        changedFilePath: CHANGED_FILE,
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator: { udid: 'SIMULATOR-1' },
        nativeBaseline: null,
        timeoutMs: 30_000,
        workspaceName: 'mobile-rearch',
        operations
      })
    ).rejects.toThrow(`Host-origin Source Control is missing ${CHANGED_FILE_LABEL}`)
    expect(operations.activate).not.toHaveBeenCalled()
  })

  it('refuses to run without an independent expected changed file', async () => {
    const { operations } = journeyOperations(['Refresh source control', CHANGED_FILE_LABEL])

    await expect(
      verifyHostedHostOriginSourceControlJourney({
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator: { udid: 'SIMULATOR-1' },
        nativeBaseline: null,
        timeoutMs: 30_000,
        workspaceName: 'mobile-rearch',
        operations
      })
    ).rejects.toThrow('needs a native baseline or a fixture changed file path')
    expect(operations.activate).not.toHaveBeenCalled()
  })

  it.each([
    [
      'the adversarial fixture row',
      { workspaceRowName: 'orca-adversarial-row' },
      'orca-adversarial-row'
    ],
    ['the worktree basename', undefined, 'mobile-rearch']
  ])('lands back on %s after the host-origin step', async (_name, adversarialFixture, expected) => {
    const hostOrigin = { workspaceDocument: { href: 'orca-mobile-web://build/' } }
    // The journey itself is covered above; the step only owns the workspace row it returns to.
    const evidenceStep = vi.fn().mockResolvedValue(hostOrigin)

    await expect(
      runHostedHostOriginSourceControlStep({
        adversarialFixture,
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator: { udid: 'SIMULATOR-1' },
        evidenceStep,
        expectedWorkspace: 'mobile-rearch',
        nativeBaseline: null,
        timeoutMs: 30_000
      })
    ).resolves.toBe(hostOrigin)

    expect(evidenceStep).toHaveBeenCalledWith(
      'host-origin Source Control journey',
      expect.any(Function)
    )
    expect(tapByLabelPrefix).toHaveBeenLastCalledWith({ udid: 'SIMULATOR-1' }, expected, 30_000)
  })
})
