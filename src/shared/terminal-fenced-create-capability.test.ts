import { expect, it } from 'vitest'
import { RUNTIME_CAPABILITIES, TERMINAL_FENCED_CREATE_RUNTIME_CAPABILITY } from './protocol-version'
import { remoteRuntimeClientCapabilities } from './remote-runtime-client-capabilities'

it('advertises fenced create outcomes in host status and every paired client transport', () => {
  expect(RUNTIME_CAPABILITIES).toContain(TERMINAL_FENCED_CREATE_RUNTIME_CAPABILITY)
  expect(remoteRuntimeClientCapabilities()).toContain(TERMINAL_FENCED_CREATE_RUNTIME_CAPABILITY)
})
