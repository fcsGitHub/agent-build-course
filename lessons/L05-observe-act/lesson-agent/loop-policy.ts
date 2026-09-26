export interface LoopObservation {
  readonly completedTurns: number;
  readonly hasNewObservation: boolean;
  readonly finalAnswerReady: boolean;
}

export function shouldContinue(s: LoopObservation): boolean {
  // 此函数体为本课开放区域；输入来自可信运行记录。
  // 返回 true 只是请求继续；宿主仍核验硬预算（maxTurns 等）。
  return s.hasNewObservation && !s.finalAnswerReady && s.completedTurns < 3;
}
