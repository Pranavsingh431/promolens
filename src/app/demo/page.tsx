import type { Metadata } from "next";

import { DemoWorkspace } from "@/components/workspace/demo-workspace";
import { DEMO_SCENARIOS, type DemoPace, type DemoScenario } from "@/demo/scenarios";

export const metadata: Metadata = { title: "Demo" };

type DemoPageProps = { searchParams: Promise<{ scenario?: string; pace?: string }> };

export default async function DemoPage({ searchParams }: DemoPageProps) {
  const params = await searchParams;
  const scenario: DemoScenario = DEMO_SCENARIOS.includes(params.scenario as DemoScenario)
    ? (params.scenario as DemoScenario)
    : "complete";
  const pace: DemoPace = params.pace === "fast" ? "fast" : "normal";
  return <DemoWorkspace scenario={scenario} pace={pace} />;
}
