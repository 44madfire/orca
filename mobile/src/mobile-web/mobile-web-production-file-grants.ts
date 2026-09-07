import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_FILE_GRANTS = capabilityGrants('file', {
  markdownRead: grantLimits(4 * 1024, 353624, 2, 8, 2),
  markdownSave: grantLimits(353624, 353624, 1, 3, 0.5),
  markdownDraftRead: grantLimits(4 * 1024, 353624, 2, 8, 2),
  markdownDraftWrite: grantLimits(353624, 256, 1, 12, 4),
  resolveTerminalPath: grantLimits(4 * 1024, 4 * 1024, 2, 12, 4),
  readTerminalArtifactChunk: grantLimits(4 * 1024, 178860, 2, 16, 4),
  releaseTerminalArtifact: grantLimits(2 * 1024, 256, 2, 24, 8)
})
