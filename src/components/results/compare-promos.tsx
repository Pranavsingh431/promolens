"use client";

import { useState } from "react";

import { CRITERIA, type CriterionId } from "@/domain/evaluation/rubric";
import type { PromoRow } from "@/client/results-model";

function optionLabel(row: PromoRow): string {
  const first = row.promo.segments[0];
  const where = first ? `Episode ${first.episode}, ${first.start}` : row.id;
  return row.status === "recommended"
    ? `Promo ${row.displayRank}: ${where}`
    : `Alternative: ${where}`;
}

/** Side-by-side ratings of this clip and one other the editor picks. Closed until asked for. */
export function ComparePromos({ current, rows }: { current: PromoRow; rows: readonly PromoRow[] }) {
  const [otherId, setOtherId] = useState<string>("");
  const others = rows.filter((row) => row.id !== current.id);
  const other = others.find((row) => row.id === otherId) ?? null;
  if (others.length === 0) return null;

  const cell = "py-1.5 pr-3 align-top [overflow-wrap:anywhere]";
  const pick = (row: PromoRow, id: CriterionId) => `${row.promo.criteria[id].rating} of 4`;

  return (
    <details className="border-t border-line px-5 py-4 text-sm sm:px-6">
      <summary className="cursor-pointer font-semibold">Compare with another promo</summary>
      <label className="mt-3 block">
        <span className="text-ink-muted">Compare with</span>
        <select
          value={otherId}
          onChange={(event) => setOtherId(event.target.value)}
          className="mt-1 block w-full rounded-sm border border-line-strong bg-surface px-2 py-1.5 text-sm"
        >
          <option value="">Choose a promo</option>
          {others.map((row) => (
            <option key={row.id} value={row.id}>
              {optionLabel(row)}
            </option>
          ))}
        </select>
      </label>
      {other ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">Ratings for the two promos</caption>
            <thead className="text-xs text-ink-muted">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  <span className="sr-only">Measure</span>
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  This clip
                </th>
                <th scope="col" className="py-1 font-medium">
                  {optionLabel(other)}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-line">
                <th scope="row" className={`${cell} font-medium`}>
                  Editorial score
                </th>
                <td className={`${cell} font-mono text-xs`}>
                  {current.promo.editorialScore.toFixed(1)}
                </td>
                <td className={`${cell} font-mono text-xs`}>
                  {other.promo.editorialScore.toFixed(1)}
                </td>
              </tr>
              {CRITERIA.map(({ id, name }) => (
                <tr key={id} className="border-t border-line">
                  <th scope="row" className={`${cell} font-medium`}>
                    {name}
                  </th>
                  <td className={`${cell} font-mono text-xs`}>{pick(current, id)}</td>
                  <td className={`${cell} font-mono text-xs`}>{pick(other, id)}</td>
                </tr>
              ))}
              <tr className="border-t border-line">
                <th scope="row" className={`${cell} font-medium`}>
                  Hook
                </th>
                <td className={`${cell} text-ink-muted`}>{current.promo.hook.explanation}</td>
                <td className={`${cell} text-ink-muted`}>{other.promo.hook.explanation}</td>
              </tr>
              <tr className="border-t border-line">
                <th scope="row" className={`${cell} font-medium`}>
                  Ending
                </th>
                <td className={`${cell} text-ink-muted`}>
                  {current.promo.cliffhanger.explanation}
                </td>
                <td className={`${cell} text-ink-muted`}>{other.promo.cliffhanger.explanation}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}
