import { z } from 'zod'
import {
  MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES,
  MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES,
  MOBILE_WEB_TERMINAL_PATH_MAX_CHARACTERS
} from '../../../../shared/mobile-web/terminal-artifact-contract'
import { MOBILE_WEB_FILE_CHUNK_MAX_BYTES } from '../../../../shared/mobile-web/bridge-operation-contract'
import { defineMethod, isStreamingMethod, type RpcContext } from '../core'
import { FILE_METHODS } from './files'
import {
  mobileWebTerminalArtifactDisplayName,
  mobileWebTerminalArtifactPreviewKind
} from './mobile-web-terminal-artifact-presentation'
import { MobileWebTerminalArtifactStore } from './mobile-web-terminal-artifact-store'
import { resolveMobileWebTerminalTab } from './mobile-web-terminal-tab-resolution'

function fileMethod(name: string) {
  const method = FILE_METHODS.find((entry) => entry.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing file method: ${name}`)
  }
  return method
}

const resolvePath = fileMethod('files.resolveTerminalPath')
const readChunk = fileMethod('files.readTerminalArtifactChunk')
const artifacts = new MobileWebTerminalArtifactStore()

const Target = z.object({
  worktree: z.string().min(1).max(4096),
  tabId: z.string().min(1).max(512)
})
const Location = z.object({
  line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  column: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable()
})
const Token = z.string().min(43).max(43)

const Resolved = z.object({
  worktree: z.string(),
  exists: z.literal(true),
  isDirectory: z.literal(false),
  openTarget: z.union([
    z.object({ kind: z.literal('worktree-file'), relativePath: z.string().min(1).max(1024) }),
    z.object({
      kind: z.literal('absolute-file'),
      absolutePath: z.string().min(1).max(4096),
      grantId: z.string().min(1).max(256)
    })
  ])
})
const Chunk = z.object({
  contentBase64: z.string(),
  bytesRead: z.number().int().nonnegative().max(MOBILE_WEB_FILE_CHUNK_MAX_BYTES),
  eof: z.boolean()
})

export const MOBILE_WEB_TERMINAL_ARTIFACT_METHODS = [
  defineMethod({
    name: 'mobileWeb.terminal.resolvePath',
    params: Target.merge(Location).extend({
      pathText: z.string().min(1).max(MOBILE_WEB_TERMINAL_PATH_MAX_CHARACTERS)
    }),
    handler: async (params, context) => {
      const connectionId = requireConnection(context)
      const terminal = await resolveMobileWebTerminalTab(context, params.worktree, params.tabId, {
        requireActive: true
      })
      const resolved = Resolved.safeParse(
        await resolvePath.handler(
          resolvePath.params!.parse({
            worktree: params.worktree,
            pathText: params.pathText,
            terminal
          }),
          context
        )
      )
      // A resolution that lands outside the addressed worktree is a different workspace's file.
      if (!resolved.success || `id:${resolved.data.worktree}` !== params.worktree) {
        throw new Error('selector_not_found')
      }
      const target = resolved.data.openTarget
      if (target.kind === 'worktree-file') {
        return {
          kind: 'worktree-file',
          relativePath: target.relativePath,
          displayName: mobileWebTerminalArtifactDisplayName(target.relativePath),
          previewKind: mobileWebTerminalArtifactPreviewKind(target.relativePath),
          line: params.line,
          column: params.column
        }
      }
      const record = artifacts.retain({
        connectionId,
        worktree: params.worktree,
        tabId: params.tabId,
        terminal,
        absolutePath: target.absolutePath,
        grantId: target.grantId,
        previewKind: mobileWebTerminalArtifactPreviewKind(target.absolutePath)
      })
      return {
        kind: 'terminal-artifact',
        token: record.token,
        displayName: mobileWebTerminalArtifactDisplayName(target.absolutePath),
        previewKind: record.previewKind,
        line: params.line,
        column: params.column
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.terminal.artifactChunk',
    params: Target.extend({
      token: Token,
      offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      length: z.number().int().min(1).max(MOBILE_WEB_FILE_CHUNK_MAX_BYTES)
    }),
    handler: async (params, context) => {
      const connectionId = requireConnection(context)
      const record = artifacts.require({ token: params.token, connectionId, tabId: params.tabId })
      const maxBytes =
        record.previewKind === 'raster'
          ? MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES
          : MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES
      if (params.offset >= maxBytes || params.length > maxBytes - params.offset) {
        throw new Error('invalid_argument')
      }
      // The grant belongs to the terminal that printed the path; a replaced PTY retires it.
      const terminal = await resolveMobileWebTerminalTab(context, record.worktree, record.tabId, {
        requireActive: true
      }).catch(() => null)
      if (terminal !== record.terminal) {
        artifacts.release(record.token)
        throw new Error('selector_not_found')
      }
      const chunk = Chunk.safeParse(
        await readChunk.handler(
          readChunk.params!.parse({
            worktree: record.worktree,
            grantId: record.grantId,
            absolutePath: record.absolutePath,
            offset: params.offset,
            length: params.length,
            maxBytes
          }),
          context
        )
      )
      if (
        !chunk.success ||
        chunk.data.bytesRead > params.length ||
        (!chunk.data.eof && chunk.data.bytesRead !== params.length)
      ) {
        artifacts.release(record.token)
        throw new Error('runtime_unavailable')
      }
      artifacts.renew(record)
      return { token: record.token, offset: params.offset, ...chunk.data }
    }
  }),
  defineMethod({
    name: 'mobileWeb.terminal.artifactRelease',
    params: Target.extend({ token: Token }),
    // A page releasing a token the TTL already reaped is not an error.
    handler: async (params, context) => {
      artifacts.releaseOwned({
        token: params.token,
        connectionId: requireConnection(context),
        tabId: params.tabId
      })
      return null
    }
  })
]

export const MOBILE_WEB_TERMINAL_ARTIFACT_STORE_FOR_TESTS = artifacts

function requireConnection(context: RpcContext): string {
  if (!context.connectionId) {
    throw new Error('runtime_unavailable')
  }
  return context.connectionId
}
