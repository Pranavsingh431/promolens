import type { Metadata } from "next";

import { DemoWorkspace } from "@/components/workspace/demo-workspace";
import { DEMO_SCENARIOS, type DemoPace, type DemoScenario } from "@/demo/scenarios";
import { demoWorkProfile } from "@/domain/calibration";

export const metadata: Metadata = { title: "Demo" };

type DemoPageProps = { searchParams: Promise<{ scenario?: string; pace?: string }> };

export default async function DemoPage({ searchParams }: DemoPageProps) {
  const params = await searchParams;
  const scenario: DemoScenario = DEMO_SCENARIOS.includes(params.scenario as DemoScenario)
    ? (params.scenario as DemoScenario)
    : "complete";
  const pace: DemoPace = params.pace === "fast" ? "fast" : "normal";
  // The demo shows the estimates the real app would show, using the default models and limits.
  return <DemoWorkspace scenario={scenario} pace={pace} estimateProfile={demoWorkProfile()} />;
}
