export interface LoopObservation {
  readonly completedTurns: number;
  readonly hasNewObservation: boolean;
  readonly finalAnswerReady: boolean;
}

export function shouldContinue(s: LoopObservation): boolean {
  // L06 基线：宽松条件配合更小的宿主硬预算，观察"软策略 vs 硬边界"。
  return s.hasNewObservation;
}
