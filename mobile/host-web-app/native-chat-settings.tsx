import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import NativeChatSettingsScreen from '../src/settings/native-chat-settings-screen'

export default function HostedChatSettingsRoute() {
  const shell = useMobileWebNativeShell()
  return (
    <NativeChatSettingsScreen
      key={shell.context?.shellSessionId ?? 'pending'}
      scope="host"
      available={shell.client?.native.supports('pagePreferences') ?? false}
    />
  )
}
