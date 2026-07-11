/** Thin facade — canonical implementation lives in failure-policy.mjs */
export {
  isAutoRetryableInput,
  autoRetryGuidance,
  planAutoRetryResponses,
} from './failure-policy.mjs'
