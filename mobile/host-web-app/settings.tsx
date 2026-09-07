import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import { useRouter } from 'expo-router'
import { Globe, MessageSquare } from 'lucide-react-native'
import { MobileSettingsFrame, MobileSettingsSection } from '../src/settings/mobile-settings-menu'

export default function HostedSettingsRoute() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  const disabled = !(shell.client?.native.supports('pagePreferences') ?? false)
  return (
    <MobileSettingsFrame
      onBack={() => {
        if (router.canGoBack()) {
          router.back()
        } else {
          router.replace('/')
        }
      }}
    >
      <MobileSettingsSection
        items={[
          {
            label: 'Chat UI',
            disabled,
            icon: MessageSquare,
            onPress: () => router.push('/native-chat-settings')
          },
          {
            label: 'Browser',
            disabled,
            icon: Globe,
            onPress: () => router.push('/browser-settings')
          }
        ]}
      />
    </MobileSettingsFrame>
  )
}
