import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MARK } from "./mark";

const ASSETS = ["promolens-mark.svg", "promolens-logo.svg", "promolens-logo-dark.svg"];

function readAsset(name: string): string {
  return readFileSync(new URL(`../../../public/brand/${name}`, import.meta.url), "utf8");
}

describe("brand assets", () => {
  it.each(ASSETS)("%s draws the same mark as the BrandMark component", (name) => {
    const svg = readAsset(name);

    expect(svg).toContain(`rx="${MARK.tileRadius}" fill="${MARK.colors.tile}"`);
    expect(svg).toContain(`d="${MARK.timeline}" stroke="${MARK.colors.timeline}"`);
    expect(svg).toContain(`d="${MARK.leftBracket}" fill="none" stroke="${MARK.colors.bracket}"`);
    expect(svg).toContain(`d="${MARK.rightBracket}" fill="none" stroke="${MARK.colors.bracket}"`);
    expect(svg).toContain(
      `<circle cx="${MARK.moment.cx}" cy="${MARK.moment.cy}" r="${MARK.moment.r}" fill="${MARK.colors.moment}"/>`,
    );
  });

  it.each(ASSETS)("%s is self-contained and has an accessible name", (name) => {
    const svg = readAsset(name);

    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="PromoLens"');
    expect(svg).not.toMatch(/<(image|script|foreignObject|text)\b/);
    expect(svg).not.toMatch(/href=/);
  });
});
