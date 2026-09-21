import type {
  PluginPanelActionOutcome,
  PluginPanelEntry,
  PluginPanelRpcOutcome
} from '../../shared/plugins/plugin-panel-bridge'
import { panelActionCallSchema, panelRpcCallSchema } from '../../shared/plugins/plugin-panel-bridge'
import {
  admitPluginPanelCall,
  createPluginPanelCallAdmission,
  type PluginPanelCallAdmission
} from '../../shared/plugins/plugin-panel-call-admission'
import { buildPluginPanelShellHtml } from '../../shared/plugins/plugin-panel-shell'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginContentVerifier } from './plugin-content-integrity'
import {
  PLUGIN_PANEL_ENTRY_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'
import { PluginPanelSessions, type PluginPanelSessionBinding } from './plugin-panel-sessions'

type PluginPanelControllerOptions = {
  resolveApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  contentVerifier: Pick<PluginContentVerifier, 'verify'>
  executeHostCall: (
    pluginKey: string,
    method: string,
    params: unknown
  ) => Promise<PluginPanelActionOutcome>
  /** Session-bound panel→own-worker RPC dispatch; bound by PluginService. */
  executeRpc?: (
    pluginKey: string,
    panelId: string,
    method: string,
    params: unknown
  ) => Promise<PluginPanelRpcOutcome>
  log: (pluginKey: string) => (line: string) => void
  panelAdmission?: PluginPanelCallAdmission
}

type LoadedPluginPanel = {
  entry: { html: string }
  binding: PluginPanelSessionBinding
}

// Shared failure codes for the session authority chain; both outcome shapes accept them.
type PanelBindingFailureCode = 'invalid_request' | 'rate_limited' | 'unavailable'

type ResolvedPanelBinding =
  | { ok: true; binding: PluginPanelSessionBinding }
  | { ok: false; code: PanelBindingFailureCode; error: string }

export class PluginPanelController {
  private readonly sessions = new PluginPanelSessions()
  private readonly boundOwnerSignals = new WeakSet<AbortSignal>()
  private readonly panelAdmission: PluginPanelCallAdmission

  constructor(private readonly options: PluginPanelControllerOptions) {
    this.panelAdmission = options.panelAdmission ?? createPluginPanelCallAdmission()
  }

  async readEntry(pluginKey: string, panelId: string): Promise<{ html: string } | null> {
    return (await this.load(pluginKey, panelId))?.entry ?? null
  }

  async open(
    ownerKey: string,
    pluginKey: string,
    panelId: string
  ): Promise<PluginPanelEntry | null> {
    const loaded = await this.load(pluginKey, panelId)
    if (!loaded) {
      return null
    }
    return {
      ...loaded.entry,
      sessionToken: this.sessions.issue(ownerKey, loaded.binding)
    }
  }

  async execute(ownerKey: string, call: unknown): Promise<PluginPanelActionOutcome> {
    const resolved = this.resolveCurrentPanelBinding(ownerKey, call)
    if (!resolved.ok) {
      return resolved
    }
    const parsed = panelActionCallSchema.safeParse(call)
    if (!parsed.success) {
      return { ok: false, code: 'invalid_request', error: 'malformed panel action call' }
    }
    return this.options.executeHostCall(
      resolved.binding.pluginKey,
      parsed.data.action,
      parsed.data.params
    )
  }

  /** Session-bound panel→own-worker RPC. Never routes through Host API
   *  execute(): the worker method set is private and separate from public
   *  host methods. Plugin/panel identity comes only from the resolved
   *  session; the iframe payload carries no authority fields. */
  async executeRpc(ownerKey: string, call: unknown): Promise<PluginPanelRpcOutcome> {
    const resolved = this.resolveCurrentPanelBinding(ownerKey, call)
    if (!resolved.ok) {
      return resolved
    }
    const parsed = panelRpcCallSchema.safeParse(call)
    if (!parsed.success) {
      return { ok: false, code: 'invalid_request', error: 'malformed panel RPC call' }
    }
    if (!this.options.executeRpc) {
      return { ok: false, code: 'unavailable', error: 'panel RPC is not available' }
    }
    try {
      return await this.options.executeRpc(
        resolved.binding.pluginKey,
        resolved.binding.panelId,
        parsed.data.method,
        parsed.data.params
      )
    } catch (error) {
      return {
        ok: false,
        code: 'action_failed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2048)
      }
    }
  }

  revokeOwner(ownerKey: string): void {
    this.sessions.revokeOwner(ownerKey)
  }

  bindOwnerSignal(ownerKey: string, signal: AbortSignal | undefined): void {
    if (!signal || this.boundOwnerSignals.has(signal)) {
      return
    }
    this.boundOwnerSignals.add(signal)
    if (signal.aborted) {
      this.revokeOwner(ownerKey)
      return
    }
    signal.addEventListener('abort', () => this.revokeOwner(ownerKey), { once: true })
  }

  revokeAll(): void {
    this.sessions.clear()
    this.panelAdmission.clear()
  }

  dispose(): void {
    this.revokeAll()
  }

  // Single authority checkpoint for panel calls: token extraction, owner-bound
  // session resolution, admission, plus current-plugin/root/revision/panel checks.
  private resolveCurrentPanelBinding(ownerKey: string, call: unknown): ResolvedPanelBinding {
    const sessionToken = this.extractSessionToken(call)
    if (!sessionToken) {
      return { ok: false, code: 'invalid_request', error: 'invalid panel session' }
    }
    const binding = this.sessions.resolve(ownerKey, sessionToken)
    if (!binding) {
      return { ok: false, code: 'invalid_request', error: 'invalid panel session' }
    }
    const admissionRefusal = admitPluginPanelCall(this.panelAdmission, binding.pluginKey, call)
    // Admit yields only shared codes, so either outcome shape accepts the refusal.
    if (admissionRefusal && !admissionRefusal.ok) {
      return admissionRefusal.code === 'rate_limited'
        ? { ok: false, code: 'rate_limited', error: admissionRefusal.error }
        : { ok: false, code: 'invalid_request', error: admissionRefusal.error }
    }
    const plugin = this.options.resolveApprovedPlugin(binding.pluginKey)
    const panelExists = plugin?.manifest.contributes.panels.some(
      (panel) => panel.id === binding.panelId
    )
    if (
      !plugin ||
      plugin.rootDir !== binding.rootDir ||
      JSON.stringify(plugin.manifest) !== binding.manifestRevision ||
      !panelExists
    ) {
      return { ok: false, code: 'unavailable', error: 'panel session is no longer available' }
    }
    return { ok: true, binding }
  }

  private extractSessionToken(call: unknown): string | null {
    if (typeof call !== 'object' || call === null) {
      return null
    }
    try {
      const token = (call as { sessionToken?: unknown }).sessionToken
      return typeof token === 'string' && token.length >= 32 && token.length <= 128 ? token : null
    } catch {
      return null
    }
  }

  private async load(pluginKey: string, panelId: string): Promise<LoadedPluginPanel | null> {
    const plugin = this.options.resolveApprovedPlugin(pluginKey)
    const panel = plugin?.manifest.contributes.panels.find((entry) => entry.id === panelId)
    if (!plugin || !panel) {
      return null
    }
    const log = this.options.log(pluginKey)
    try {
      await this.options.contentVerifier.verify(plugin)
      const html = buildPluginPanelShellHtml(
        await readContainedPluginArtifactText(
          plugin.rootDir,
          panel.entry,
          PLUGIN_PANEL_ENTRY_MAX_BYTES
        )
      )
      const current = this.options.resolveApprovedPlugin(pluginKey)
      if (current !== plugin || current.rootDir !== plugin.rootDir) {
        return null
      }
      return {
        entry: { html },
        binding: {
          pluginKey,
          panelId,
          rootDir: plugin.rootDir,
          manifestRevision: JSON.stringify(plugin.manifest)
        }
      }
    } catch (error) {
      log(
        `panel entry ${panel.entry} rejected: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }
}
