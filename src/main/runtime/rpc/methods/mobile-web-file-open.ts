import { z } from 'zod'
import { defineMethod, isStreamingMethod } from '../core'
import { FILE_METHODS } from './files'
import { activateMobileWebFileTab } from './mobile-web-file-tab-activation'

function fileMethod(name: string) {
  const method = FILE_METHODS.find((entry) => entry.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing file method: ${name}`)
  }
  return method
}

const open = fileMethod('files.open')
const openDiff = fileMethod('files.openDiff')

export const MOBILE_WEB_FILE_OPEN_METHOD = defineMethod({
  name: 'mobileWeb.files.open',
  params: z.object({
    worktree: z.string().min(1).max(4096),
    relativePath: z.string().min(1).max(4096),
    mode: z.enum(['edit', 'diff']),
    staged: z.boolean().default(false)
  }),
  handler: async (params, context) => {
    const source = params.mode === 'diff' ? openDiff : open
    await source.handler(
      source.params!.parse({
        worktree: params.worktree,
        relativePath: params.relativePath,
        ...(params.mode === 'diff' ? { staged: params.staged } : {})
      }),
      context
    )
    // A tab the host opened but never activated leaves the page on its old route.
    const activated = await activateMobileWebFileTab(
      {
        worktree: params.worktree,
        relativePath: params.relativePath,
        mode: params.mode,
        staged: params.staged
      },
      context
    )
    return { opened: true, activated }
  }
})
