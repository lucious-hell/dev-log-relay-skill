import type { HarnessVerifyInput, HarnessVerifyResult } from "../types.js";

export interface HarnessOrchestratorAdapters {
  verifyWeb(input: HarnessVerifyInput): Promise<HarnessVerifyResult>;
  verifyMiniapp(input: HarnessVerifyInput): Promise<HarnessVerifyResult>;
}

export class HarnessOrchestrator {
  constructor(private readonly adapters: HarnessOrchestratorAdapters) {}

  async verify(input: HarnessVerifyInput): Promise<HarnessVerifyResult> {
    return input.target === "miniapp"
      ? this.adapters.verifyMiniapp(input)
      : this.adapters.verifyWeb({ ...input, target: "web" });
  }
}
