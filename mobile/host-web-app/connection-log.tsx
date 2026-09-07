import { useRouter } from 'expo-router'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import { HostedConnectionDiagnosticsScreen } from '../src/diagnostics/hosted-connection-diagnostics-screen'

export default function HostedConnectionLogRoute() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  if (!shell.client) {
    return null
  }
  return (
    <HostedConnectionDiagnosticsScreen
      key={shell.context?.shellSessionId ?? 'pending'}
      client={shell.client}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
    />
  )
}
