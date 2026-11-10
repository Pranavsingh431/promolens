import { LoadingState } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <main id="main" className="mx-auto max-w-workspace px-4 sm:px-6">
      <LoadingState label="Loading PromoLens" />
    </main>
  );
}
