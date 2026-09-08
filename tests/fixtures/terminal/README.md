`pr-base-1d1b73c40850-pty-transport.txt` is the exact
`src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts` from PR
#19358's base commit `1d1b73c40850`, excluding only its leading max-lines lint
suppression comment. Keep this historical reader frozen.

The compatibility test compiles this data fixture as CommonJS with esbuild and
loads its dependencies through Vitest's mocked module graph. It exercises the
historical create-success/failure behavior without shipping the old transport or
adding a source line-cap exemption. It is not a full historical client binary;
transitive dependencies and stream doubles come from the current checkout.
