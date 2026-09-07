import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'expo-router'
import { Pressable, Text } from 'react-native'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import { MobileSettingsFrame } from '../src/settings/mobile-settings-menu'
import TerminalSettingsScreen from '../src/terminal/terminal-settings-screen'
import {
  webTerminalSettingsHost,
  webTerminalSettingsOperations
} from '../src/terminal/web-terminal-settings-operations'
import type { TerminalSettingsHost } from '../src/terminal/terminal-settings-operations'
import { terminalSettingsScreenStyles as styles } from '../src/terminal/terminal-settings-screen-styles'

export default function HostedTerminalSettingsRoute() {
  const shell = useMobileWebNativeShell()
  return <HostedTerminalSettings key={shell.context?.shellSessionId ?? 'pending'} />
}
function HostedTerminalSettings() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  const client = shell.client
  const operations = useMemo(
    () => (client ? webTerminalSettingsOperations(client) : null),
    [client]
  )
  const [hosts, setHosts] = useState<TerminalSettingsHost[]>([])
  const [loadingHost, setLoadingHost] = useState(true)
  const [hostLoadFailed, setHostLoadFailed] = useState(false)
  useEffect(() => {
    let active = true
    if (client) {
      void webTerminalSettingsHost(client)
        .then((host) => {
          if (active) {
            setHosts(host ? [host] : [])
          }
        })
        .catch(() => {
          if (active) {
            setHostLoadFailed(true)
          }
        })
        .finally(() => {
          if (active) {
            setLoadingHost(false)
          }
        })
    }
    return () => {
      active = false
    }
  }, [client])
  const onBack = () => {
    if (router.canGoBack()) {
      router.back()
    } else {
      router.replace('/settings')
    }
  }
  if (!client?.native.supports('pagePreferences') || !operations) {
    return (
      <MobileSettingsFrame onBack={onBack}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open device terminal settings"
          style={styles.row}
          onPress={() => {
            void client?.navigationRoute({ destination: 'terminalSettings' }).catch(() => {})
          }}
        >
          <Text style={styles.rowLabel}>Open device terminal settings</Text>
        </Pressable>
      </MobileSettingsFrame>
    )
  }
  return (
    <TerminalSettingsScreen
      scope="host"
      hosts={hosts}
      operations={operations}
      onBack={onBack}
      hostUnavailableMessage={
        loadingHost
          ? 'Loading terminal restore settings…'
          : hostLoadFailed
            ? 'Could not load terminal restore settings. Go back and try again.'
            : 'Terminal restore settings are not available with this desktop or app version.'
      }
    />
  )
}
