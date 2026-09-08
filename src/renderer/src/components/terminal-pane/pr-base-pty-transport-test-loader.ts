import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transformSync } from 'esbuild'
import type { createRemoteRuntimePtyTransport } from './remote-runtime-pty-transport'

export async function loadPrBasePtyTransport(): Promise<{
  createRemoteRuntimePtyTransport: typeof createRemoteRuntimePtyTransport
}> {
  // Frozen PR-base reader, evaluated with the same mocked dependencies as the current transport.
  const source = readFileSync(
    resolve('tests/fixtures/terminal/pr-base-1d1b73c40850-pty-transport.txt'),
    'utf8'
  )
  const { code: outputText } = transformSync(source, { loader: 'ts', format: 'cjs' })
  const dependencies = new Map<string, unknown>()
  for (const match of outputText.matchAll(/require\("([^"]+)"\)/g)) {
    const specifier = match[1]
    if (!dependencies.has(specifier)) {
      const target = specifier.startsWith('@/')
        ? resolve('src/renderer/src', specifier.slice(2))
        : resolve(__dirname, specifier)
      dependencies.set(specifier, await import(/* @vite-ignore */ target))
    }
  }
  const exports = {} as { createRemoteRuntimePtyTransport: typeof createRemoteRuntimePtyTransport }
  const module = { exports }
  new Function('require', 'exports', 'module', outputText)(
    (name: string) => dependencies.get(name),
    exports,
    module
  )
  return module.exports
}
