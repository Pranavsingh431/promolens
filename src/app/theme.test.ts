import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Checks the color tokens in globals.css against WCAG 2.2 contrast minimums:
 * 4.5:1 for text, 3:1 for focus rings and component borders.
 */

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

function tokensIn(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--pl-([a-z-]+):\s*(#[0-9a-f]{6});/gi)) {
    const [, name, value] = match;
    if (name && value) tokens[name] = value;
  }
  return tokens;
}

function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`Missing ${marker} in globals.css`);
  const open = css.indexOf("{", css.indexOf(":root", start));
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

const themes = {
  light: tokensIn(blockAfter(":root")),
  dark: tokensIn(blockAfter("@media (prefers-color-scheme: dark)")),
};

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const TEXT_PAIRS: Array<[foreground: string, background: string]> = [
  ["ink", "canvas"],
  ["ink", "surface"],
  ["ink", "sunken"],
  ["ink-muted", "canvas"],
  ["ink-muted", "surface"],
  ["ink-muted", "sunken"],
  ["accent-ink", "canvas"],
  ["accent-ink", "surface"],
  ["on-accent", "accent"],
  ["danger", "danger-surface"],
  ["ink", "danger-surface"],
];

const NON_TEXT_PAIRS: Array<[foreground: string, background: string]> = [
  ["accent-ink", "canvas"],
  ["line-strong", "surface"],
  ["line-strong", "sunken"],
];

describe.each(Object.entries(themes))("%s theme", (_name, tokens) => {
  function color(name: string): string {
    const value = tokens[name];
    if (!value) throw new Error(`Token --pl-${name} is not defined`);
    return value;
  }

  it.each(TEXT_PAIRS)("%s on %s meets 4.5:1", (fg, bg) => {
    expect(contrast(color(fg), color(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT_PAIRS)("%s on %s meets 3:1", (fg, bg) => {
    expect(contrast(color(fg), color(bg))).toBeGreaterThanOrEqual(3);
  });
});
