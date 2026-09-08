import { expect, it } from 'vitest'
import {
  isRelayAiVaultServiceRequest,
  relayAiVaultServiceLane,
  type RelayAiVaultServiceRequest
} from './ai-vault-service-protocol'

const search = (action: 'query' | 'status' | 'configure'): RelayAiVaultServiceRequest => ({
  type: 'request',
  id: 1,
  operation: 'search',
  action,
  params: {}
})

it('keeps a history scan and a search query off the lane that backs interactive reads', () => {
  expect(relayAiVaultServiceLane({ type: 'request', id: 1, operation: 'list', params: {} })).toBe(
    'cache'
  )
  expect(relayAiVaultServiceLane(search('query'))).toBe('search')
  expect(
    relayAiVaultServiceLane({ type: 'request', id: 1, operation: 'titles', requests: [] })
  ).toBe('interactive')
  expect(relayAiVaultServiceLane(search('status'))).toBe('interactive')
  expect(relayAiVaultServiceLane(search('configure'))).toBe('interactive')
  expect(new Set([relayAiVaultServiceLane(search('query')), 'interactive']).size).toBe(2)
})

it('refuses a search request whose action is not one this build owns', () => {
  expect(isRelayAiVaultServiceRequest(search('query'))).toBe(true)
  expect(
    isRelayAiVaultServiceRequest({ type: 'request', id: 1, operation: 'search', params: {} })
  ).toBe(false)
  expect(
    isRelayAiVaultServiceRequest({
      type: 'request',
      id: 1,
      operation: 'search',
      action: 'drop',
      params: {}
    })
  ).toBe(false)
})
