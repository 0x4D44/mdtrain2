// AWS/TPWS future seam — typed no-op stub. Phase 1 ships only the shape: a
// reasons-shaped output and one pure fold point. Phase 2 grows the deadline /
// warning state machine behind `tickAws` and starts returning reasons, with no
// change to the shared penalty latch or `resolveInputs`.

import type { PenaltyReason } from "./controls";
import type { SimState } from "./simulation";

export interface AwsOutput {
  /** Penalty reasons asserted this tick. Empty in Phase 1. */
  reasons: PenaltyReason[];
}

export function tickAws(_state: SimState, _dt: number): AwsOutput {
  return { reasons: [] }; // Phase-1 no-op pass-through (the fold point)
}
