import {
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES
} from '../../../src/shared/mobile-web/source-control-history-contract'
import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'
import { MOBILE_WEB_PRODUCTION_SOURCE_CONTROL_REVIEW_GRANTS } from './mobile-web-production-source-control-review-grants'

export const MOBILE_WEB_PRODUCTION_SOURCE_CONTROL_GRANTS = [
  ...capabilityGrants('sourceControl', {
    branches: grantLimits(2 * 1024, 64 * 1024, 2, 8, 2),
    history: grantLimits(4 * 1024, MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES, 2, 6, 1),
    branchCompare: grantLimits(
      4 * 1024,
      MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES,
      2,
      8,
      2
    ),
    commitCompare: grantLimits(
      4 * 1024,
      MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES,
      2,
      12,
      3
    )
  }),
  ...MOBILE_WEB_PRODUCTION_SOURCE_CONTROL_REVIEW_GRANTS,
  ...capabilityGrants('sourceControl', {
    stage: grantLimits(96 * 1024, 40 * 1024, 1, 8, 4),
    unstage: grantLimits(96 * 1024, 40 * 1024, 1, 8, 4),
    discard: grantLimits(96 * 1024, 40 * 1024, 1, 4, 1),
    commit: grantLimits(96 * 1024, 8 * 1024, 1, 4, 1),
    generateCommitMessage: grantLimits(96 * 1024, 16 * 1024, 1, 4, 0.25),
    cancelCommitMessageGeneration: grantLimits(2 * 1024, 2 * 1024, 2, 8, 4),
    upstream: grantLimits(2 * 1024, 8 * 1024, 2, 8, 2),
    branch: grantLimits(4 * 1024, 8 * 1024, 1, 4, 1),
    fetch: grantLimits(4 * 1024, 8 * 1024, 1, 4, 1),
    pull: grantLimits(8 * 1024, 8 * 1024, 1, 3, 0.5),
    push: grantLimits(8 * 1024, 8 * 1024, 1, 3, 0.5),
    rebase: grantLimits(8 * 1024, 8 * 1024, 1, 2, 0.25),
    abort: grantLimits(4 * 1024, 8 * 1024, 1, 4, 1)
  })
]
