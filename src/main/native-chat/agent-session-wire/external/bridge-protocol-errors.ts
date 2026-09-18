// Error types for the SNC1.3 external structured-session bridge.
//
// Split from `bridge-protocol` (line budget): fail-closed errors thrown across the
// transport, validation, and host layers. Imports nothing, so every layer can name
// these without a cycle.

/** Error for local protocol violations (never carries prompt/env values). */
export class BridgeProtocolError extends Error {
  readonly code: string;
  constructor(message: string, code = "BRIDGE_PROTOCOL") {
    super(message);
    this.name = "BridgeProtocolError";
    this.code = code;
  }
}

/** Error for unavailable/incompatible bridges (fail-closed, fall back to TUI). */
export class BridgeUnavailableError extends Error {
  readonly code: string;
  constructor(message: string, code = "BRIDGE_UNAVAILABLE") {
    super(message);
    this.name = "BridgeUnavailableError";
    this.code = code;
  }
}

/** Error for bounded-deadline expiry (dispatch maps these to `unknown`). */
export class BridgeTimeoutError extends Error {
  readonly code = "BRIDGE_TIMEOUT";
  constructor(message: string) {
    super(message);
    this.name = "BridgeTimeoutError";
  }
}
