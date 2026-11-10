/**
 * Geometry and fixed colors of the PromoLens mark: in and out trim brackets
 * around a highlighted moment on a timeline.
 *
 * public/brand/*.svg contain the same shapes. brand-assets.test.ts fails if the
 * files and these values drift apart.
 */
export const MARK = {
  viewBox: "0 0 64 64",
  tileRadius: 15,
  timeline: "M8 32H56",
  leftBracket: "M24 19H17V45H24",
  rightBracket: "M40 19H47V45H40",
  moment: { cx: 32, cy: 32, r: 7.5 },
  strokeWidth: { timeline: 2.5, bracket: 4.5 },
  colors: {
    tile: "#17130E",
    edge: "#FFFFFF",
    timeline: "#6E6457",
    bracket: "#F6F0E6",
    moment: "#F2A93B",
  },
} as const;
