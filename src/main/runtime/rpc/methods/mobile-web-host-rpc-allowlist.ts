import { mobileWebHostUnsubscribeMethod } from '../../../../shared/mobile-web/host-rpc-contract'

// Only page-safe results belong here; transport credentials never reach a mobile-scope socket.
export const MOBILE_WEB_HOST_RPC_METHODS = new Set([
  'mobileWeb.sourceControl.status',
  'mobileWeb.sourceControl.diff',
  'mobileWeb.files.readDir',
  'files.readChunk',
  'mobileWeb.files.searchPaths',
  'mobileWeb.files.read',
  'mobileWeb.files.watch',
  'mobileWeb.terminal.action',
  'mobileWeb.nativeChat.read',
  'mobileWeb.nativeChat.mutate',
  'mobileWeb.nativeChat.fileSearch',
  'mobileWeb.nativeChat.openFile',
  'mobileWeb.nativeChat.readability',
  'mobileWeb.nativeChat.subscribe',
  'mobileWeb.session.snapshot',
  'mobileWeb.session.subscribe',
  'mobileWeb.session.activate',
  'mobileWeb.session.close',
  'mobileWeb.session.createBrowser',
  'mobileWeb.session.quickCommands',
  'mobileWeb.session.quickCommandMutate',
  'mobileWeb.session.createQuickCommand',
  'mobileWeb.session.agentOptions',
  'mobileWeb.session.createTerminal',
  'mobileWeb.session.capabilities',
  'terminal.getAutoRestoreFit',
  'terminal.setAutoRestoreFit',
  'speech.models.list',
  'speech.models.download',
  'speech.models.delete',
  'speech.dictation.setup'
])

// The shell derives a cancel name from the subscribe name, so the gate admits exactly those.
export const MOBILE_WEB_HOST_RPC_CANCEL_METHODS = new Set(
  [...MOBILE_WEB_HOST_RPC_METHODS].flatMap((method) => mobileWebHostUnsubscribeMethod(method) ?? [])
)

export function isMobileWebHostRpcMethod(method: string): boolean {
  return MOBILE_WEB_HOST_RPC_METHODS.has(method) || MOBILE_WEB_HOST_RPC_CANCEL_METHODS.has(method)
}
