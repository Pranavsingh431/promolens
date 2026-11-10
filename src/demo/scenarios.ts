/** Which made-up analysis the demo plays. Kept apart from the data, so routes stay light. */
export const DEMO_SCENARIOS = ["complete", "partial", "empty", "failed"] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];
/** "fast" exists for automated browser tests. */
export type DemoPace = "normal" | "fast";
