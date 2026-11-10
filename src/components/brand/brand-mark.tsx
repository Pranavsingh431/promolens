import { MARK } from "./mark";

type BrandMarkProps = {
  size?: number;
  /** Plays a slow trim animation. Used for loading states. Respects reduced motion. */
  animated?: boolean;
  /** Accessible name. Leave empty when the mark sits next to visible text. */
  title?: string;
  className?: string;
};

export function BrandMark({ size = 32, animated = false, title, className }: BrandMarkProps) {
  const { colors, strokeWidth } = MARK;

  return (
    <svg
      viewBox={MARK.viewBox}
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect width="64" height="64" rx={MARK.tileRadius} fill={colors.tile} />
      <rect
        x="0.5"
        y="0.5"
        width="63"
        height="63"
        rx={MARK.tileRadius - 0.5}
        fill="none"
        stroke={colors.edge}
        strokeOpacity="0.12"
      />
      <path
        d={MARK.timeline}
        stroke={colors.timeline}
        strokeWidth={strokeWidth.timeline}
        strokeLinecap="round"
      />
      <path
        d={MARK.leftBracket}
        fill="none"
        stroke={colors.bracket}
        strokeWidth={strokeWidth.bracket}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animated ? "motion-safe:animate-trim-in" : undefined}
      />
      <path
        d={MARK.rightBracket}
        fill="none"
        stroke={colors.bracket}
        strokeWidth={strokeWidth.bracket}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animated ? "motion-safe:animate-trim-in-reverse" : undefined}
      />
      <circle
        cx={MARK.moment.cx}
        cy={MARK.moment.cy}
        r={MARK.moment.r}
        fill={colors.moment}
        className={animated ? "motion-safe:animate-moment" : undefined}
      />
    </svg>
  );
}
