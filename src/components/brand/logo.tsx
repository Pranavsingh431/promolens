import { BrandMark } from "./brand-mark";

/** Mark plus wordmark. The wordmark is live text so it stays sharp and readable. */
export function Logo({ markSize = 32 }: { markSize?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <BrandMark size={markSize} />
      <span className="font-display text-2xl leading-none">
        Promo<span className="italic">Lens</span>
      </span>
    </span>
  );
}
