import { useCallback, useState } from 'react'
import { Text } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { DiagnosticsSnapshot } from '../../../src/shared/mobile-web/diagnostics-device-contract'
import type { ConnectionLogEntry } from '../transport/types'
import type { MobileWebDiagnosticsSnapshot } from '../mobile-web/mobile-web-diagnostics-store'
import { ConnectionDiagnosticsView } from './connection-diagnostics-view'
import {
  diagnoseConnection,
  getReportableConnectionIncidentId
} from './connection-diagnostics-analysis'
import { buildConnectionDiagnosticsReport } from './connection-diagnostics-report'
import {
  getDiagnosticsSubmissionState,
  updateDiagnosticsSubmissionState,
  type DiagnosticsSubmissionStates
} from './connection-diagnostics-screen-data'
import { connectionDiagnosticsScreenStyles as styles } from './connection-diagnostics-screen-styles'

export function HostedConnectionDiagnosticsScreen({
  client,
  onBack
}: {
  client: MobileWebBridgeClient
  onBack: () => void
}) {
  const device = client.native.diagnosticsDevice
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [submissions, setSubmissions] = useState<DiagnosticsSubmissionStates>({})
  useFocusEffect(
    useCallback(() => {
      let active = true
      let pending = false
      const refresh = async () => {
        if (pending) {
          return
        }
        pending = true
        try {
          const next = await device.snapshot()
          if (active) {
            setSnapshot(next)
            setError(null)
          }
        } catch {
          if (active) {
            setError('Could not load network diagnostics. Retrying…')
          }
        } finally {
          pending = false
        }
      }
      void refresh()
      const interval = setInterval(() => void refresh(), 2000)
      return () => {
        active = false
        clearInterval(interval)
      }
    }, [device])
  )
  const data = snapshot
    ? {
        ...snapshot,
        entries: snapshot.entries as ConnectionLogEntry[],
        mobileWeb: snapshot.mobileWeb as MobileWebDiagnosticsSnapshot
      }
    : null
  const diagnosis = data ? diagnoseConnection(data) : null
  const incident = data ? getReportableConnectionIncidentId(data) : null
  const submissionState = getDiagnosticsSubmissionState(submissions, incident)
  const copyDiagnostics = async () => {
    try {
      const fresh = await device.snapshot()
      await client.native.clipboardWrite(
        buildConnectionDiagnosticsReport({
          ...fresh,
          entries: fresh.entries as ConnectionLogEntry[],
          mobileWeb: fresh.mobileWeb as MobileWebDiagnosticsSnapshot
        })
      )
      setCopied(true)
    } catch {
      setError('Could not copy the report. Try again.')
    }
  }
  const sendDiagnostics = async () => {
    if (!incident || submissionState === 'sending') {
      return
    }
    const started = incident
    setSubmissions((states) => updateDiagnosticsSubmissionState(states, started, 'sending'))
    try {
      const fresh = await device.snapshot()
      const reportData = {
        ...fresh,
        entries: fresh.entries as ConnectionLogEntry[],
        mobileWeb: fresh.mobileWeb as MobileWebDiagnosticsSnapshot
      }
      if (getReportableConnectionIncidentId(reportData) !== started) {
        setSubmissions((states) => updateDiagnosticsSubmissionState(states, started, null))
        return
      }
      const result = await device.submit({
        report: buildConnectionDiagnosticsReport(reportData),
        appVersion: fresh.appVersion,
        platform: fresh.platform
      })
      setSubmissions((states) =>
        updateDiagnosticsSubmissionState(states, started, result.ok ? 'sent' : 'failed')
      )
    } catch {
      setSubmissions((states) => updateDiagnosticsSubmissionState(states, started, 'failed'))
    }
  }
  return (
    <ConnectionDiagnosticsView
      loading={!snapshot}
      hostName="Paired desktop"
      state={snapshot?.state ?? 'disconnected'}
      reconnectAttempts={snapshot?.reconnectAttempts ?? 0}
      entries={data?.entries ?? []}
      diagnosis={diagnosis}
      copied={copied}
      copyDiagnostics={copyDiagnostics}
      submissionState={submissionState}
      sendDiagnostics={sendDiagnostics}
      onBack={onBack}
      hostPicker={
        error ? (
          <Text accessibilityRole="alert" style={styles.emptyText}>
            {error}
          </Text>
        ) : null
      }
    />
  )
}
