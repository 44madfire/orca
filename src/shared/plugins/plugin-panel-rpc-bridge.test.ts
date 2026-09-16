import { describe, expect, it } from 'vitest'
import {
  PANEL_ACTION_REQUEST_TYPE,
  PANEL_RPC_REQUEST_TYPE,
  PANEL_RPC_RESULT_TYPE,
  looksLikePanelRpcRequest,
  panelRpcCallSchema,
  panelRpcRequestSchema,
  panelRpcResultSchema,
  parsePanelActionRequest,
  parsePanelRpcRequest
} from './plugin-panel-bridge'

describe('panel RPC shared protocol', () => {
  it('parses a valid orca-panel-rpc request with method, requestId, and params', () => {
    const parsed = parsePanelRpcRequest({
      type: 'orca-panel-rpc',
      requestId: 'req-1',
      method: 'panel.echo',
      params: { hello: 'world' }
    })
    expect(parsed).toEqual({
      ok: true,
      request: {
        type: PANEL_RPC_REQUEST_TYPE,
        requestId: 'req-1',
        method: 'panel.echo',
        params: { hello: 'world' }
      }
    })
  })

  it('parses a valid request without params', () => {
    const parsed = parsePanelRpcRequest({ type: 'orca-panel-rpc', requestId: 'r', method: 'a.b' })
    expect(parsed.ok).toBe(true)
  })

  it('rejects malformed request ids and methods with bounded correlation', () => {
    for (const data of [
      { type: 'orca-panel-rpc', requestId: '', method: 'panel.echo' },
      { type: 'orca-panel-rpc', requestId: 'x'.repeat(129), method: 'panel.echo' },
      { type: 'orca-panel-rpc', requestId: 'req-1', method: '' },
      { type: 'orca-panel-rpc', requestId: 'req-1', method: 'not a method!!' },
      { type: 'orca-panel-rpc', method: 'panel.echo' }
    ]) {
      const parsed = parsePanelRpcRequest(data)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.error.length).toBeLessThanOrEqual(512)
      }
    }
    // Correlatable id is still surfaced so the host can answer the sender.
    const parsed = parsePanelRpcRequest({ type: 'orca-panel-rpc', requestId: 'req-9', method: '' })
    expect(parsed).toMatchObject({ ok: false, requestId: 'req-9' })
    const uncorrelatable = parsePanelRpcRequest({ type: 'orca-panel-rpc', method: '' })
    expect(uncorrelatable).toMatchObject({ ok: false, requestId: null })
  })

  it('does not accept target-authority fields from the iframe payload', () => {
    for (const data of [
      { type: 'orca-panel-rpc', requestId: 'r', method: 'a.b', pluginKey: 'orca-samples.other' },
      { type: 'orca-panel-rpc', requestId: 'r', method: 'a.b', sessionToken: 's'.repeat(43) },
      { type: 'orca-panel-rpc', requestId: 'r', method: 'a.b', panelId: 'other' },
      { type: 'orca-panel-rpc', requestId: 'r', method: 'a.b', worktreeId: 'w' },
      { type: 'orca-panel-rpc', requestId: 'r', method: 'a.b', pluginId: 'x.y' }
    ]) {
      expect(panelRpcRequestSchema.safeParse(data).success).toBe(false)
      expect(parsePanelRpcRequest(data).ok).toBe(false)
    }
    // The relay call shape carries only the host-added token plus method.
    expect(
      panelRpcCallSchema.safeParse({
        sessionToken: 's'.repeat(43),
        method: 'panel.echo',
        pluginKey: 'orca-samples.other'
      }).success
    ).toBe(false)
    expect(
      panelRpcCallSchema.safeParse({ sessionToken: 's'.repeat(43), method: 'panel.echo' }).success
    ).toBe(true)
  })

  it('accepts valid success/failure results and rejects malformed shapes', () => {
    expect(
      panelRpcResultSchema.safeParse({
        type: PANEL_RPC_RESULT_TYPE,
        requestId: 'req-1',
        ok: true,
        value: { hello: 'world' }
      }).success
    ).toBe(true)
    expect(
      panelRpcResultSchema.safeParse({
        type: PANEL_RPC_RESULT_TYPE,
        requestId: 'req-1',
        ok: false,
        errorCode: 'unknown_method',
        error: 'unknown RPC method panel.missing'
      }).success
    ).toBe(true)
    for (const malformed of [
      { type: PANEL_RPC_RESULT_TYPE, requestId: 'req-1', ok: true, pluginKey: 'x.y' },
      { type: PANEL_RPC_RESULT_TYPE, requestId: '', ok: true },
      { type: PANEL_RPC_RESULT_TYPE, requestId: 'req-1', ok: false },
      {
        type: PANEL_RPC_RESULT_TYPE,
        requestId: 'req-1',
        ok: false,
        errorCode: 'capability_denied',
        error: 'x'
      },
      { type: PANEL_RPC_RESULT_TYPE, requestId: 'req-1', ok: 'yes' }
    ]) {
      expect(panelRpcResultSchema.safeParse(malformed).success).toBe(false)
    }
  })

  it('leaves the existing orca-panel-action parsing unchanged', () => {
    expect(
      parsePanelActionRequest({
        type: PANEL_ACTION_REQUEST_TYPE,
        requestId: 'req-1',
        action: 'notifications.show',
        params: { title: 'Hello' }
      }).ok
    ).toBe(true)
    expect(looksLikePanelRpcRequest({ type: PANEL_ACTION_REQUEST_TYPE })).toBe(false)
    expect(looksLikePanelRpcRequest({ type: PANEL_RPC_REQUEST_TYPE })).toBe(true)
  })
})
