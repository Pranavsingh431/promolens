import { BrandMark } from "@/components/brand/brand-mark";

export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" className="flex flex-col items-center gap-4 py-16 text-center">
      <BrandMark size={48} animated />
      <p className="text-sm text-ink-muted">{label}</p>
    </div>
  );
}
