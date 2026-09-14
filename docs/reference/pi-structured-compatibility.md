# Pi Structured Compatibility (SNC1.10 Orca slice)

Host-owned gates for native Pi structured sessions. The provider slice
(`44madfire/orca-pi` PR 54) owns the bridge/native provider enforcement;
this repository owns the Orca production wiring that consumes the evidence.

## Gates (enforced, not advisory)

- Location first-line: `supportsCreate` admits only `local` host, no WSL
  distro, plus Windows start-time proof. All else fails closed to Pi TUI.
- Pre-spawn: `PiStructuredSessionAdapter` checks `pi --version` floor
  (`0.85.1`, SemVer prerelease-aware) and required capabilities against the
  static advertisement. Production (`requireCompatEvidence: true`) refuses
  missing version or empty capability evidence with
  `PI_COMPAT_EVIDENCE_MISSING` before any child exists.
- Post-start: `PiRpcSessionLifecycle` re-verifies live RPCs on the running
  child before exposure — option catalogs plus `setModel` /
  `setThinkingLevel` / `setAutoCompaction` presence, image-capable model
  when `images` is required, readable `get_entries` / `get_tree` for
  `history`, `switchSession` presence for `resume`, and `get_state`
  identity. Refusal closes the just-started child (no leak) with
  `PI_COMPAT_CAPABILITY`.
- Every structured acquire carries `{ piVersion, requiredCapabilities,
  executionHostId, wslDistro }`; production required set is
  `textStreaming, thinking, tools, options, history, cancel, resume,
  extensionDialogs` (`images` only when a turn requests it).

## TUI fallback (recoverable)

`PI_COMPAT_LOCATION`, `PI_COMPAT_VERSION`, `PI_COMPAT_CAPABILITY`,
`PI_COMPAT_EVIDENCE_MISSING`, `PI_STARTUP_FAILED`, `PI_STATE_FAILED`,
`PI_TUI_FLAG`, and `BAD_WORKSPACE` are `AgentSessionPreSpawnError`
(processless) and classify to `retry-tui`. Structured→TUI uses the exact
session file on the durable chain head (`pi --session <file>`); TUI→structured
resumes wholesale root→leaf with no duplication.

## Support matrix (honest)

| Dimension | Proven | Expected, unproven | Unsupported (Pi TUI) |
| --- | --- | --- | --- |
| Pi version | `0.85.1` (live-captured fixture) | Newer (floor passes, probing decides) | Older, unparseable |
| Location | Local host, no WSL | — | Remote/SSH/mobile/paired, any WSL |
| OS | `win32` local (fixtures captured on win32) | darwin/linux local (same stdio transport, no recorded run here) | Any other claim without a run |
| Transport | `pi --mode rpc` stdio, LF-only JSONL, argv arrays | — | Shell strings, keystroke injection |

Darwin/linux local structured Pi is expected-compatible but has zero
recorded runs in this repository. WSL, remote/SSH, mobile, and paired
locations have no lifecycle/filesystem/capability evidence and fail closed.

## Security

No credentials, private prompts, raw session paths, or image bytes in logs,
fixtures, or diagnostics. Errors carry codes plus safe summaries only.
Image bytes ride the RPC but are never journaled. Public APIs take and return
plain data; transport construction uses argv arrays only. `unknown` delivery
is never auto-resent; teardown proves root exit plus descendant cleanup and
never fabricates a clean exit.
