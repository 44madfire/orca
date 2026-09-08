# Prompt delivery repair

Base: `588240043e84b1f8e58013298e692e7a57ba8ad5` (newer than triage `9f044031fc9`). All 18 named Linear descriptions/comments refreshed through `orca linear issue --full --json`; targeted open-PR searches checked before implementation. No Linear mutations, user-session cleanup, visible app launches, or other authors' PR edits. Hidden validation startup had an unexpected provider-bootstrap side effect noted below.

## Implemented

Notes sent to a proven Claude/Codex target now use the existing runtime `terminal.send` / `sendTerminalAgentPrompt` transaction, instead of independent paste and Enter RPCs separated by 50 ms. Runtime still checks permission and exact PTY binding before paste and before submit, owns host-specific ingestion timing and serializes delivery, and uses the incumbent submission verifier. Errors do not trigger a legacy re-paste. An additive, optional `terminal.agentStatus.supportsGuardedAgentPrompt` flag gates the client behavior; old clients ignore it, new clients retain the incumbent two-phase path on old/unsupported hosts. Unsupported or changed targets cannot turn a combined guarded request into unguarded shell input.

The change is intentionally focused: no second verifier, startup shell gate changes, new submit binding, automatic retries, lifecycle/cleanup changes, or provider-local slash-command success inference. Renderer calls currently have no durable orchestration request ID; durable CLI receipt replay remains the existing flow and is regression-tested, not claimed as newly implemented UI retry support.

## Issue disposition

No complete historical ticket closure is claimed by this draft.

| Issue | Disposition and evidence |
| --- | --- |
| STA-4495 | Partial: notes now reuse the shipped verifier; silent-success half already changed in v1.4.187 per latest corrective comment. Core composer/receipt work remains in #18022 / #16198. |
| STA-2380 | Pending existing #10020 for launchAgent/quiescence trust gate; Codex MCP input-missing variant explicitly outside that PR and not reproduced here. |
| STA-3793 | Pending: Codex MCP cold-start loss not exercised by this notes repair; historical presence/readiness asymmetry is not closure evidence. |
| STA-2655 | Pending: comments identify both composer-pending and input-missing variants; no blanket historical closure. Related #10020 / #18022. |
| STA-2912 | Pending existing #15698 (large atomic paste) and #18196 (render-gate ingestion floor). Main already has size-dependent host ingestion; no duplicate core patch. |
| STA-4318 | Pending: Windows/macOS Claude worker symptoms remain outside notes caller coverage; #18022 / #16198 overlap. |
| STA-5642 | Partial: notes half fixed through host transaction. Startup `agent-paste-draft.ts` remains separate and overlaps #16716 / #18996; 50 ms fallback retained for old hosts. |
| STA-5951 | Pending existing #18020: interactive CLI launchAgent inference already has a focused open fix, including remote clients. |
| STA-6211 | Partial mechanism coverage only: notes change does not close worker cold delivery or wrong-pane capability binding; latter belongs to identity worker. #18022 addresses composer proof. |
| STA-5869 | Pending: manual Enter recovery/capability revocation is orchestration core, overlapping #16198 / #15941; no timeout inflation here. |
| STA-6779 | Pending: automation reuse still calls renderer submit helper; selected-session submission and #18996 integration need validation. Resource worker owns reuse ownership. |
| STA-6437 | Pending existing #15275 late shell-ready startup-command repair; shell readiness is distinct from agent readiness and untouched. Current daemon startup tests already exercise shell-ready routing. |
| STA-6432 | Pending existing #18087: fresh working-to-done completion fence; no duplicate automation edit. |
| STA-6755 | Pending existing #18996: configured Enter/Ctrl+Enter setting and recipe/reuse submit bytes. Do not claim fixed by routing notes. |
| STA-5379 | Pending: historical Git AI action recipe symptom not reproduced; startup caller overlaps #18996 / #16716. |
| STA-5150 | Pending existing #16198 and #16290: local slash-command/non-turn verdict and dirty composer refusal are distinct. Notes errors never trigger automatic re-paste, but no new local-command success outcome. |
| STA-6763 | Pending: description is title-only; comments propose timeout inflation without measured evidence. No arbitrary acknowledgment-window change. |
| STA-2631 | Partial existing guards regression-tested; current verifier already blocks permission sequences. Historical trust/Antigravity scrollback detection requires live provider reproduction; #10020 is adjacent. |

All PR numbers above link under `https://github.com/stablyai/orca/pull/<number>` and were found open when checked, not treated as merged fixes.

## Validation

- All commands used `ORCA_BACKGROUND_LAUNCH=1`.
- `pnpm tc:node` and `pnpm tc:web`: passed.
- Focused oxlint, changed-code quality (native/type-aware/React Doctor: zero findings), and `git diff --check`: passed.
- Final focused regressions: **8 files, 129 tests passed**, including Windows ingestion, runtime submission, RPC guard, durable receipt replay, old-host notes fallback, and new local/paired notes tests.
- New coverage: single large notes RPC on local/paired targets, wait for verified result, permission refusal, no automatic replay after ambiguous failure, guarded transaction routing/rechecks, signal forwarding, rejection after settlement support changes, durable guarded receipt replay without duplicate body/Enter.
- Existing focused suites cover Windows/POSIX host ingestion, SSH Windows write-host selection, permission/cancellation, small/large prompt verification, durable receipts, and old-host focused/explicit notes paths. These are deterministic tests on macOS, not live Windows/SSH/WSL end-to-end proof.
- Coordinator supplied the Electron skill after local lookup failed. Rebuilt and launched this worktree hidden with isolated ORCA_DEV_USER_DATA_PATH, CDP 9341 and renderer 5183; app.getIdentity confirmed this checkout. Inspected /tmp/orca-prompt-hidden-renderer.png: empty workspace welcome screen, zero terminal sessions. This is startup/render proof only, not before/after notes-delivery evidence; manual checklist remains unchecked.
- Validation stopped after startup unexpectedly logged two `codex-trust-grant` messages with `host=native, wrote=true` (8 managed hook entries). Isolated app profile does not fully isolate provider bootstrap. Escalated to coordinator, launched no agents, performed no config rollback; stopped only recorded validation process tree and verified both ports closed. Own-profile ledger confirms the two affected homes: `/Users/nwparker/.codex` and `/tmp/orca-prompt-delivery-validation-profile/codex-runtime-home/home`, each 8 entries. Source is `codex-real-home-hook-install.ts` real-home grant with `useDefaultCodexHome: true`; native launcher deletes CODEX_HOME. Existing `tests/e2e/helpers/electron-home-isolation.ts` is the required full home boundary. `ORCA_DISABLE_CODEX_TRUST_RPC` alone does not prevent all hook/config writes.

## Remaining work

Review this focused draft alongside the existing PRs above; validate hidden live provider sessions on isolated Windows/WSL and SSH hosts, including configured Ctrl+Enter and provider-local commands. Preserve separately owned automation/session changes. Coordinator handles Linear accounting; do not close partially covered reports.
