export type AiCostQuestionsMode = "ASK";

// The only reader of the cost-question mode. Every paid AI step asks first. An "OFF" mode waits
// for a one-time consent at sign-up (spec section 6); until then this always returns "ASK".
export function aiCostQuestionsMode(): AiCostQuestionsMode {
  return "ASK";
}
