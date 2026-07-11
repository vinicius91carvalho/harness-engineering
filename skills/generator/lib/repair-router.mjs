/** Thin facade — canonical implementation lives in failure-policy.mjs */
export {
  DEFECT_CLASSES,
  REPAIR_ACTIONS,
  inferDefectClass,
  routeRepair,
  routePendingInput,
} from './failure-policy.mjs'
