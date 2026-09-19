import {
  PANEL_ACTION_RESULT_TYPE,
  PANEL_CONTROL_MESSAGE_MAX_BYTES,
  PANEL_RPC_REQUEST_TYPE,
  PANEL_RPC_RESULT_TYPE,
  looksLikePanelActionRequest,
  looksLikePanelRpcRequest,
  parsePanelActionRequest,
  parsePanelRpcRequest,
  readPanelPongId,
  type PluginPanelActionOutcome,
  type PluginPanelActionResultMessage,
  type PluginPanelRpcOutcome,
  type PluginPanelRpcResultMessage
} from '../../../../shared/plugins/plugin-panel-bridge'
import {
  createPanelControlMessageBudget,
  createPanelMessageBudget,
  structuredCloneMessageBytes,
  type PanelMessageBudget
} from '../../../../shared/plugins/plugin-panel-message-budget'
import { translate } from '@/i18n/i18n'

/**
 * Host side of the plugin panel postMessage bridge. Framework-free so
 * message validation, budgets, and relay behavior are directly
 * unit-testable; PluginPanel wires the returned listener to `window` while
 * the panel iframe is mounted.
 *
 * Main issues an opaque session while loading the mounted panel. The guest
 * never sees or supplies plugin identity, and main binds the session again.
 */

export type PanelActionCall = {
  sessionToken: string
  action: string
  params?: unknown
}

export type PanelRpcCall = {
  sessionToken: string
  method: string
  params?: unknown
}

export type PanelBridgeHostOptions = {
  sessionToken: string
  /** The mounted panel iframe's contentWindow, or null when unmounted. */
  getPanelWindow: () => Window | null
  callPanelAction: (call: PanelActionCall) => Promise<PluginPanelActionOutcome>
  /** Panel→own-worker RPC relay. Absent on old preloads: RPC then reports unavailable. */
  callPanelRpc?: (call: PanelRpcCall) => Promise<PluginPanelRpcOutcome>
  /** False once the requesting panel document/session has been replaced. */
  isActive?: () => boolean
  onPong?: (pingId: number) => void
  /** Injectable for tests; defaults to the shared per-plugin budget. */
  budget?: PanelMessageBudget
  /** Reserved liveness budget; defaults to the shared control-frame budget. */
  controlBudget?: PanelMessageBudget
  now?: () => number
}

/** Matches the panelRpcResultSchema error cap so a relay throw stays postable. */
const PANEL_BRIDGE_ERROR_MAX_LENGTH = 8192

function toBoundedBridgeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    PANEL_BRIDGE_ERROR_MAX_LENGTH
  )
}

/** Relays a bridge call through the preload API, degrading to a bridge-level
 *  error when the preload predates the plugins.panelAction surface. */
export function callPanelActionViaPreload(
  call: PanelActionCall
): Promise<PluginPanelActionOutcome> {
  const panelAction = window.api?.plugins?.panelAction
  if (!panelAction) {
    return Promise.resolve({
      ok: false,
      code: 'unavailable',
      error: translate(
        'auto.components.rightSidebar.pluginPanelBridgeHost.actionsUnavailable',
        'Plugin actions are not available in this client.'
      )
    })
  }
  return panelAction(call)
}

/** Relays a panel RPC through the preload API, degrading to a bridge-level
 *  error when the preload predates the plugins.panelRpc surface. */
export function callPanelRpcViaPreload(call: PanelRpcCall): Promise<PluginPanelRpcOutcome> {
  const panelRpc = window.api?.plugins?.panelRpc
  if (!panelRpc) {
    return Promise.resolve({
      ok: false,
      code: 'unavailable',
      error: translate(
        'auto.components.rightSidebar.pluginPanelBridgeHost.actionsUnavailable',
        'Plugin actions are not available in this client.'
      )
    })
  }
  return panelRpc(call)
}

type PanelBridgeHandlerState = {
  options: PanelBridgeHostOptions
  budget: PanelMessageBudget
  controlBudget: PanelMessageBudget
  now: () => number
  requestingWindow: Window
}

// Single post path so stale-document checks cannot drift between result types.
function postPanelBridgeResult(
  state: PanelBridgeHandlerState,
  message: PluginPanelActionResultMessage | PluginPanelRpcResultMessage
): void {
  if (
    state.options.isActive?.() === false ||
    state.options.getPanelWindow() !== state.requestingWindow
  ) {
    return
  }
  // Why: targetOrigin must be '*' — an opaque origin never matches a
  // concrete origin, so anything stricter would silently drop the reply.
  state.requestingWindow.postMessage(message, '*')
}

function handlePanelPong(state: PanelBridgeHandlerState, data: unknown, pongId: number): void {
  const timestamp = state.now()
  // One walk, capped at the smaller lane bound, serves both budgets: a
  // pong above that cap is refused here anyway.
  const pongBytes = structuredCloneMessageBytes(
    data,
    state.controlBudget.maxBytes ?? PANEL_CONTROL_MESSAGE_MAX_BYTES
  )
  // Charged to both: the data budget still meters this traffic, while a
  // refusal there cannot by itself silence liveness.
  state.budget.admit(timestamp, pongBytes)
  if (!state.controlBudget.admit(timestamp, pongBytes)) {
    state.options.onPong?.(pongId)
  }
}

function handlePanelActionRequest(state: PanelBridgeHandlerState, data: unknown): void {
  const parsed = parsePanelActionRequest(data)
  if (!parsed.ok) {
    if (parsed.requestId) {
      postPanelBridgeResult(state, {
        type: PANEL_ACTION_RESULT_TYPE,
        requestId: parsed.requestId,
        ok: false,
        errorCode: 'invalid_request',
        error: parsed.error
      })
    }
    return
  }
  const { requestId, action, params } = parsed.request
  state.options
    .callPanelAction({ sessionToken: state.options.sessionToken, action, params })
    .then((outcome) => {
      postPanelBridgeResult(
        state,
        outcome.ok
          ? { type: PANEL_ACTION_RESULT_TYPE, requestId, ok: true, value: outcome.value }
          : {
              type: PANEL_ACTION_RESULT_TYPE,
              requestId,
              ok: false,
              errorCode: outcome.code,
              error: outcome.error
            }
      )
    })
    .catch((error: unknown) => {
      postPanelBridgeResult(state, {
        type: PANEL_ACTION_RESULT_TYPE,
        requestId,
        ok: false,
        errorCode: 'action_failed',
        error: toBoundedBridgeError(error)
      })
    })
}

function handlePanelRpcRequest(state: PanelBridgeHandlerState, data: unknown): void {
  const parsed = parsePanelRpcRequest(data)
  if (!parsed.ok) {
    if (parsed.requestId) {
      postPanelBridgeResult(state, {
        type: PANEL_RPC_RESULT_TYPE,
        requestId: parsed.requestId,
        ok: false,
        errorCode: 'invalid_request',
        error: parsed.error
      })
    }
    return
  }
  const { requestId, method, params } = parsed.request
  const relay = state.options.callPanelRpc ?? callPanelRpcViaPreload
  relay({ sessionToken: state.options.sessionToken, method, params })
    .then((outcome) => {
      postPanelBridgeResult(
        state,
        outcome.ok
          ? { type: PANEL_RPC_RESULT_TYPE, requestId, ok: true, value: outcome.value }
          : {
              type: PANEL_RPC_RESULT_TYPE,
              requestId,
              ok: false,
              errorCode: outcome.code,
              error: outcome.error
            }
      )
    })
    .catch((error: unknown) => {
      postPanelBridgeResult(state, {
        type: PANEL_RPC_RESULT_TYPE,
        requestId,
        ok: false,
        errorCode: 'action_failed',
        error: toBoundedBridgeError(error)
      })
    })
}

export function createPanelBridgeMessageHandler(
  options: PanelBridgeHostOptions
): (event: MessageEvent) => void {
  const budget = options.budget ?? createPanelMessageBudget()
  const controlBudget = options.controlBudget ?? createPanelControlMessageBudget()
  const now = options.now ?? (() => Date.now())
  return (event: MessageEvent): void => {
    const panelWindow = options.getPanelWindow()
    // Why: the sandboxed srcdoc frame has an opaque origin ("null"), so the
    // sending window's identity — not event.origin — is the only trustworthy
    // check that this message came from our panel and not another frame.
    if (!panelWindow || event.source !== panelWindow) {
      return
    }
    const state: PanelBridgeHandlerState = {
      options,
      budget,
      controlBudget,
      now,
      requestingWindow: panelWindow
    }
    // A valid pong is the one frame the host must never lose: it takes a
    // reserved lane so a panel saturating its data budget can still prove it
    // is alive. Only schema-valid pongs qualify, so near-miss pong-shaped junk
    // cannot drain the lane the real reply needs — it falls through to the
    // data budget below like any other malformed frame.
    const pongId = readPanelPongId(event.data)
    if (pongId !== null) {
      handlePanelPong(state, event.data, pongId)
      return
    }
    // Budgets run before parsing: a flood of malformed junk must not buy
    // free schema-validation CPU either. Actions and RPC share one budget so
    // RPC cannot become an unlimited second lane around panel limits.
    const refusal = budget.admit(now(), structuredCloneMessageBytes(event.data, budget.maxBytes))
    if (refusal) {
      const requestId =
        typeof event.data === 'object' && event.data !== null
          ? (event.data as { requestId?: unknown }).requestId
          : undefined
      if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128) {
        const error =
          refusal === 'oversized'
            ? translate(
                'auto.components.rightSidebar.pluginPanelBridgeHost.messageTooLarge',
                'Message exceeds the size limit.'
              )
            : translate(
                'auto.components.rightSidebar.pluginPanelBridgeHost.tooManyRequests',
                'Too many requests.'
              )
        if (
          typeof event.data === 'object' &&
          event.data !== null &&
          (event.data as { type?: unknown }).type === PANEL_RPC_REQUEST_TYPE
        ) {
          postPanelBridgeResult(state, {
            type: PANEL_RPC_RESULT_TYPE,
            requestId,
            ok: false,
            errorCode: refusal === 'oversized' ? 'invalid_request' : 'rate_limited',
            error
          })
        } else {
          postPanelBridgeResult(state, {
            type: PANEL_ACTION_RESULT_TYPE,
            requestId,
            ok: false,
            errorCode: refusal === 'oversized' ? 'invalid_request' : 'rate_limited',
            error
          })
        }
      }
      return
    }
    // RPC relay: the iframe supplies only method/params; the host attaches
    // the session token at relay time and never forwards caller identity.
    if (looksLikePanelRpcRequest(event.data)) {
      handlePanelRpcRequest(state, event.data)
      return
    }
    if (!looksLikePanelActionRequest(event.data)) {
      return
    }
    handlePanelActionRequest(state, event.data)
  }
}
