/**
 * Versioned local IPC protocol for the SNC1.3 external structured-session bridge.
 *
 * Provider-neutral core: this file knows about neither Pi RPC semantics nor
 * Orca journal/lease/outbox types. Pi assumptions live in `pi-mapping.ts`
 * (orca-pi owned); Orca session ownership stays in the Orca fork. The Orca
 * fork vendors `framing.ts` + this file + `host.ts` as a small temporary
 * dev branch — no public plugin-manifest widening.
 *
 * Split across modules (line budget); this entry keeps the public surface stable:
 * - `bridge-protocol-types`: constants, payload shapes, operation ids.
 * - `bridge-protocol-messages`: every record shape that crosses the transport.
 * - `bridge-protocol-validation`: credential guards and field validators.
 * - `bridge-protocol-message-validation`: the top-level record dispatcher.
 * Secret hygiene and error types stay here.
 */

import { MAX_STDERR_BYTES } from "./bridge-protocol-types";

export * from "./bridge-protocol-types";
export * from "./bridge-protocol-messages";
export * from "./bridge-protocol-validation";
export * from "./bridge-protocol-message-validation";
export * from "./bridge-protocol-errors";

const SECRET_VALUE_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "bearer", re: /bearer\s+[A-Za-z0-9\-._~+/=]{16,}/gi },
  { name: "api-key", re: /sk-(?:proj-)?[A-Za-z0-9\-_]{16,}/g },
  { name: "oauth", re: /ya29\.[A-Za-z0-9\-_]{16,}|xox[bpas]-[A-Za-z0-9\-_]{8,}/g },
];

/**
 * Redact secret-like values from diagnostics (bounded stderr snippets,
 * error strings). Never throws; returns a redacted copy. Prompt text is
 * *not* redacted here — callers must avoid putting prompt text into
 * diagnostics at all (see `sanitizeErrorForDisplay` in `host.ts`).
 */
export function redactSecretsFromText(text: string, limit = MAX_STDERR_BYTES): string {
  let out = text;
  for (const p of SECRET_VALUE_PATTERNS) {out = out.replace(p.re, "[redacted]");}
  if (out.length > limit) {out = out.slice(-limit);}
  return out;
}
