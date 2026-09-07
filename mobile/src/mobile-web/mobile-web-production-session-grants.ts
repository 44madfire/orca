import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_SESSION_GRANTS = [
  ...capabilityGrants('agentHistory', {
    snapshot: grantLimits(2 * 1024, 384 * 1024, 1, 8, 2),
    preview: grantLimits(512, 24 * 1024, 4, 12, 4),
    resume: grantLimits(1 * 1024, 2 * 1024, 1, 3, 0.25)
  })
]
