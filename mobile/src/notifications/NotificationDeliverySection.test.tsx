import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { NotificationDeliverySection } from './NotificationDeliverySection'
import { DEFAULT_NOTIFICATION_DELIVERY } from './notification-delivery-preferences'

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value },
  View: 'View',
  Text: 'Text',
  Switch: 'Switch'
}))

it('keeps inherited controls visible and disables editing until mirroring is off', () => {
  const onChange = vi.fn()
  let renderer: ReturnType<typeof create>
  act(() => {
    renderer = create(
      createElement(NotificationDeliverySection, { value: DEFAULT_NOTIFICATION_DELIVERY, onChange })
    )
  })
  const switches = () => renderer.root.findAllByType('Switch' as never)
  expect(switches().map((node) => node.props.accessibilityLabel)).toEqual([
    'Use desktop settings',
    'Agent task complete',
    'Terminal bell',
    'Plugin notifications',
    'Only when away from desktop',
    'Notification sound',
    'Suppress while focused'
  ])
  expect(switches()[1].props.disabled).toBe(true)
  expect(switches()[2].props.disabled).toBe(true)
  act(() => switches()[0].props.onValueChange(false))
  const independent = onChange.mock.calls[0][0]
  expect(independent.followDesktop).toBe(false)
  act(() =>
    renderer.update(createElement(NotificationDeliverySection, { value: independent, onChange }))
  )
  expect(switches()[1].props.disabled).toBe(false)
  expect(switches().map((node) => node.props.accessibilityLabel)).toContain('Terminal bell')
  act(() =>
    switches()
      .find((node) => node.props.accessibilityLabel === 'Terminal bell')!
      .props.onValueChange(false)
  )
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ terminalBell: false, taskFinished: true, needsInput: true })
  )
  act(() => renderer.unmount())
})
