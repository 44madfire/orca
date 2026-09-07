import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import { useState } from 'react'
import { Text } from 'react-native'
import { colors, typography, spacing } from '../src/theme/mobile-theme'
import { useRouter } from 'expo-router'
import {
  Globe,
  MessageSquare,
  Terminal,
  Mic,
  Bell,
  Activity,
  Info,
  Shield,
  LifeBuoy
} from 'lucide-react-native'
import { MobileSettingsFrame, MobileSettingsSection } from '../src/settings/mobile-settings-menu'

export default function HostedSettingsRoute() {
  const router = useRouter()
  const [linkError, setLinkError] = useState<string | null>(null)
  const shell = useMobileWebNativeShell()
  const disabled = !(shell.client?.native.supports('pagePreferences') ?? false)
  const linksDisabled = !(shell.client?.native.supports('openExternal') ?? false)
  const openExternal = (url: string) => {
    setLinkError(null)
    void shell.client?.native
      .openExternal(url)
      .catch(() => setLinkError('Could not open the link. Try again.'))
  }
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
            label: 'Terminal',
            icon: Terminal,
            disabled: !shell.client,
            onPress: () => {
              router.push('/terminal-settings')
            }
          },
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
          },
          {
            label: 'Voice',
            icon: Mic,
            disabled: !shell.client,
            onPress: () => router.push('/voice-settings')
          },
          {
            label: 'Notifications',
            icon: Bell,
            disabled: !shell.client,
            onPress: () => router.push('/notifications')
          },
          {
            label: 'Troubleshooting',
            icon: Activity,
            disabled: !shell.client,
            onPress: () => router.push('/troubleshoot')
          },
          { label: 'About', icon: Info, onPress: () => router.push('/about') }
        ]}
      />
      <MobileSettingsSection
        spaced
        items={[
          {
            label: 'Privacy Policy',
            icon: Shield,
            external: true,
            disabled: linksDisabled,
            onPress: () => openExternal('https://www.onorca.dev/privacy')
          },
          {
            label: 'Support',
            icon: LifeBuoy,
            external: true,
            disabled: linksDisabled,
            onPress: () => openExternal('https://github.com/stablyai/orca/issues')
          }
        ]}
      />
      {linkError && (
        <Text
          accessibilityRole="alert"
          style={{
            color: colors.textSecondary,
            fontSize: typography.bodySize,
            marginTop: spacing.md
          }}
        >
          {linkError}
        </Text>
      )}
    </MobileSettingsFrame>
  )
}
