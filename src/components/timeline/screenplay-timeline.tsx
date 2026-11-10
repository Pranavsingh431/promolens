"use client";

import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { Interval } from "@/domain/evaluation/candidate";
import type { EventKind } from "@/domain/screenplay/schema";
import type { Timeline } from "@/domain/screenplay/timeline";
import { formatTimecode } from "@/domain/screenplay/timecode";
import { formatRange, formatSeconds, joinClasses } from "@/client/format";
import {
  LANES,
  buildSegmentLayouts,
  type SegmentLayout,
  type TimelineBar,
  type TimelineEvent,
  type TimelineMode,
} from "@/client/timeline-layout";
import { StatusPill } from "@/components/ui/status-pill";

type TimelineProps = {
  timeline: Timeline;
  segments: readonly Interval[];
  hookIds: ReadonlySet<string>;
  endingIds: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (eventId: string) => void;
};

const KIND_WORD: Record<EventKind, string> = {
  dialogue: "Dialogue",
  action: "Action",
  sound: "Sound",
  camera: "Camera",
};

/** A bar and its row in the list both carry this, so one click handler serves all of them. */
function eventIdFrom(target: EventTarget): string | null {
  return (target as HTMLElement).closest<HTMLElement>("[data-event-id]")?.dataset.eventId ?? null;
}

function describeEvent(item: TimelineEvent): string {
  const { event, role, inClip } = item;
  const who = event.speaker ? `${event.speaker}: ` : "";
  const tags = [role.hook ? "hook evidence" : "", role.ending ? "ending evidence" : ""]
    .filter(Boolean)
    .join(", ");
  return `${KIND_WORD[event.kind]}, ${event.startText} to ${event.endText}. ${who}${event.text}${tags ? ` (${tags})` : ""}${inClip ? "" : " (outside the clip)"}`;
}

function barClass(bar: TimelineBar, selected: boolean): string {
  return joinClasses(
    "absolute h-2 rounded-[2px]",
    bar.selectable && "cursor-pointer",
    bar.role.ending
      ? "evidence-stripes border border-accent-ink"
      : bar.role.hook
        ? "border border-accent-ink bg-accent"
        : bar.event.kind === "dialogue"
          ? "bg-ink-muted"
          : "bg-line-strong",
    !bar.inClip && "opacity-40",
    selected && "outline-2 outline-offset-1 outline-ink",
  );
}

const Bar = memo(function Bar({ bar, selected }: { bar: TimelineBar; selected: boolean }) {
  return (
    <span
      data-event-id={bar.selectable ? bar.event.id : undefined}
      data-selected={selected ? "true" : undefined}
      data-evidence={bar.role.hook ? "hook" : bar.role.ending ? "ending" : undefined}
      title={`${KIND_WORD[bar.event.kind]} ${bar.event.startText} to ${bar.event.endText}`}
      className={barClass(bar, selected)}
      style={{
        left: `${bar.leftPercent}%`,
        width: `${bar.widthPercent}%`,
        top: `${bar.row * 11 + 3}px`,
      }}
    />
  );
});

/**
 * One tab stop for the whole track. Arrow keys step through events, and screen
 * readers hear each one through aria-valuetext. The list below shows the same
 * events as text.
 */
const Track = memo(function Track({
  layout,
  selectedId,
  onSelect,
  label,
}: {
  layout: SegmentLayout;
  selectedId: string | null;
  onSelect: (eventId: string) => void;
  label: string;
}) {
  const { listEvents: events, lanes, ticks, scenes, clip, hookBand, endingBand, cuts } = layout;
  const selectedIndex = events.findIndex((item) => item.event.id === selectedId);
  const current = events[Math.max(selectedIndex, 0)];

  function onKeyDown(event: KeyboardEvent) {
    const last = events.length - 1;
    const here = selectedIndex;
    const next: Record<string, number> = {
      ArrowRight: Math.min(here + 1, last),
      ArrowDown: Math.min(here + 1, last),
      ArrowLeft: Math.max(here - 1, 0),
      ArrowUp: Math.max(here - 1, 0),
      Home: 0,
      End: last,
      PageDown: Math.min(here + 5, last),
      PageUp: Math.max(here - 5, 0),
    };
    const target = next[event.key];
    if (target === undefined || last < 0) return;
    event.preventDefault();
    const item = events[target];
    if (item) onSelect(item.event.id);
  }

  const startCut = cuts.find((cut) => cut.edge === "start");
  const endCut = cuts.find((cut) => cut.edge === "end");
  const clipWideEnoughForLabels = clip.widthPercent >= 28;

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={Math.max(events.length, 1)}
      aria-valuenow={Math.max(selectedIndex, 0) + 1}
      aria-valuetext={current ? describeEvent(current) : "No events"}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        const id = eventIdFrom(event.target);
        if (id) onSelect(id);
      }}
      className="relative rounded-sm pl-[4.25rem]"
    >
      <div className="relative h-4 overflow-hidden" aria-hidden="true">
        {scenes
          .filter(({ showLabel }) => showLabel)
          .map(({ scene, leftPercent }) => (
            <span
              key={scene.id}
              title={scene.heading}
              className="absolute top-0 pl-1 font-mono text-[10px] whitespace-nowrap text-ink-muted"
              style={{ left: `${leftPercent}%` }}
            >
              Scene {scene.number}
            </span>
          ))}
      </div>
      <div className="relative h-4" aria-hidden="true">
        {ticks.map(({ ms, leftPercent }) => (
          <span
            key={ms}
            className="absolute top-0 -translate-x-1/2 font-mono text-[10px] text-ink-muted"
            style={{ left: `${leftPercent}%` }}
          >
            {formatTimecode(ms, 0)}
          </span>
        ))}
      </div>
      <div className="relative" aria-hidden="true">
        <div className="pointer-events-none absolute inset-0">
          {hookBand ? (
            <span
              className="absolute inset-y-0 bg-accent/30"
              style={{ left: `${hookBand.leftPercent}%`, width: `${hookBand.widthPercent}%` }}
            />
          ) : null}
          {endingBand ? (
            <span
              className="absolute inset-y-0 bg-accent-ink/20"
              style={{ left: `${endingBand.leftPercent}%`, width: `${endingBand.widthPercent}%` }}
            />
          ) : null}
          <span
            data-testid="clip-range"
            className="absolute inset-y-0 border-x-2 border-accent-ink bg-accent/10"
            style={{ left: `${clip.leftPercent}%`, width: `${clip.widthPercent}%` }}
          />
          {scenes
            .filter(({ isBoundary }) => isBoundary)
            .map(({ scene, leftPercent }) => (
              <span
                key={scene.id}
                data-testid="scene-boundary"
                className="absolute inset-y-0 border-l border-dashed border-line-strong"
                style={{ left: `${leftPercent}%` }}
              />
            ))}
        </div>
        {lanes.map((lane) => (
          <div
            key={lane.kind}
            className="relative border-t border-line"
            style={{ height: `${lane.rows * 11 + 6}px` }}
          >
            <span className="absolute top-0.5 -left-[4.25rem] text-[11px] text-ink-muted">
              {lane.label}
            </span>
            {lane.bars.map((bar) => (
              <Bar key={bar.event.id} bar={bar} selected={bar.event.id === selectedId} />
            ))}
          </div>
        ))}
        {startCut ? <CutMark leftPercent={clip.leftPercent} /> : null}
        {endCut ? <CutMark leftPercent={clip.leftPercent + clip.widthPercent} /> : null}
      </div>
      {clipWideEnoughForLabels ? (
        <div className="relative mt-1 h-4 font-mono text-[10px] text-accent-ink" aria-hidden="true">
          <span className="absolute" style={{ left: `${clip.leftPercent}%` }}>
            {formatTimecode(layout.segment.startMs)}
          </span>
          <span
            className="absolute -translate-x-full"
            style={{ left: `${clip.leftPercent + clip.widthPercent}%` }}
          >
            {formatTimecode(layout.segment.endMs)}
          </span>
        </div>
      ) : null}
    </div>
  );
});

function CutMark({ leftPercent }: { leftPercent: number }) {
  return (
    <span
      data-testid="cut-mark"
      className="pointer-events-none absolute top-1/2 z-10 flex size-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-danger-surface"
      style={{ left: `${leftPercent}%` }}
    >
      !
    </span>
  );
}

function EventRow({ item, selected }: { item: TimelineEvent; selected: boolean }) {
  const { event, role, inClip, cut } = item;
  return (
    <li
      data-event-id={event.id}
      aria-current={selected ? "true" : undefined}
      className={joinClasses(
        "grid cursor-pointer gap-x-3 border-t border-line px-2 py-1.5 sm:grid-cols-[9.5rem_minmax(0,1fr)]",
        selected && "bg-accent/15",
        !inClip && "text-ink-muted",
      )}
    >
      <span className="font-mono text-xs whitespace-nowrap text-ink-muted">
        {event.startText} to {event.endText}
      </span>
      <span className="min-w-0">
        <span className="text-xs font-medium text-ink-muted">
          {event.speaker ?? KIND_WORD[event.kind]}
        </span>
        {role.hook ? (
          <span className="ml-1.5">
            <StatusPill tone="accent">Hook</StatusPill>
          </span>
        ) : null}
        {role.ending ? (
          <span className="ml-1.5">
            <StatusPill tone="caution">Ending</StatusPill>
          </span>
        ) : null}
        {!inClip ? <span className="ml-1.5 text-xs">Outside the clip</span> : null}
        {cut ? (
          <span className="ml-1.5 text-xs font-medium text-danger">
            {formatSeconds(cut.cutMs)} of this line is cut at the {cut.edge}
          </span>
        ) : null}
        <span className="block text-sm [overflow-wrap:anywhere]">{event.text}</span>
      </span>
    </li>
  );
}

const EventList = memo(function EventList({
  layout,
  kinds,
  selectedId,
  onSelect,
  label,
  timeline,
}: {
  layout: SegmentLayout;
  kinds: ReadonlySet<EventKind>;
  selectedId: string | null;
  onSelect: (eventId: string) => void;
  label: string;
  timeline: Timeline;
}) {
  const container = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const scenes = timeline.episode(layout.segment.episode)?.scenes ?? [];
    const out: Array<TimelineEvent | { heading: string; id: string }> = [];
    let lastScene: string | null = null;
    for (const item of layout.listEvents) {
      if (!kinds.has(item.event.kind)) continue;
      if (item.event.sceneId !== lastScene) {
        lastScene = item.event.sceneId;
        const scene = scenes.find((s) => s.id === item.event.sceneId);
        out.push({ id: item.event.sceneId, heading: `Scene ${scene?.number}: ${scene?.heading}` });
      }
      out.push(item);
    }
    return out;
  }, [layout, kinds, timeline]);

  // Only this list scrolls, never the page around it.
  useEffect(() => {
    const box = container.current;
    if (!box || !selectedId) return;
    const row = box.querySelector<HTMLElement>(`[data-event-id="${selectedId}"]`);
    if (row) box.scrollTop = row.offsetTop - box.clientHeight / 3;
  }, [selectedId]);

  return (
    <div
      ref={container}
      role="region"
      tabIndex={0}
      aria-label={label}
      className="relative mt-3 max-h-72 overflow-y-auto rounded-sm border border-line"
    >
      {rows.length ? (
        <ol
          onClick={(event) => {
            const id = eventIdFrom(event.target);
            if (id) onSelect(id);
          }}
        >
          {rows.map((row) =>
            "heading" in row ? (
              <li
                key={row.id}
                className="sticky top-0 z-10 border-t border-line bg-sunken px-2 py-1 text-xs font-semibold [overflow-wrap:anywhere]"
              >
                {row.heading}
              </li>
            ) : (
              <EventRow key={row.event.id} item={row} selected={row.event.id === selectedId} />
            ),
          )}
        </ol>
      ) : (
        <p className="p-3 text-sm text-ink-muted">Nothing to show with these filters.</p>
      )}
    </div>
  );
});

const LEGEND = "inline-block h-2 w-4 rounded-[2px] border border-accent-ink";

export function ScreenplayTimeline({
  timeline,
  segments,
  hookIds,
  endingIds,
  selectedId,
  onSelect,
}: TimelineProps) {
  const [mode, setMode] = useState<TimelineMode>("clip");
  const [kinds, setKinds] = useState<ReadonlySet<EventKind>>(
    () => new Set(LANES.map((lane) => lane.kind)),
  );
  const layouts = useMemo(
    () =>
      buildSegmentLayouts({
        timeline,
        segments,
        hookEventIds: hookIds,
        endingEventIds: endingIds,
        mode,
      }),
    [timeline, segments, hookIds, endingIds, mode],
  );

  function toggleKind(kind: EventKind) {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  const modeButton = (value: TimelineMode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      onClick={() => setMode(value)}
      className={joinClasses(
        "cursor-pointer px-2.5 py-1 text-xs font-medium",
        mode === value ? "bg-ink text-canvas" : "bg-surface text-ink-muted hover:bg-sunken",
      )}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          <span className="flex items-center gap-1">
            <span aria-hidden="true" className={`${LEGEND} bg-accent`} /> Hook evidence
          </span>
          <span className="flex items-center gap-1">
            <span aria-hidden="true" className={`${LEGEND} evidence-stripes`} /> Ending evidence
          </span>
          <span className="flex items-center gap-1">
            <span aria-hidden="true" className={`${LEGEND} bg-accent/10`} /> Clip
          </span>
        </div>
        <div
          role="group"
          aria-label="Timeline range"
          className="inline-flex overflow-hidden rounded-sm border border-line-strong"
        >
          {modeButton("clip", "Clip")}
          {modeButton("episode", "Whole episode")}
        </div>
      </div>

      {layouts.map((layout) => {
        const { segment, index, cuts, truncatedFrom } = layout;
        const name = `Segment ${index + 1} of ${layouts.length}, episode ${segment.episode}`;
        return (
          <section key={`${segment.episode}-${segment.startMs}`} aria-label={name} className="mt-4">
            <p className="mb-1 text-xs font-medium">
              {layouts.length > 1 ? `Segment ${index + 1} · ` : ""}Episode {segment.episode} ·{" "}
              <span className="font-mono">{formatRange(segment.startMs, segment.endMs)}</span>
            </p>
            <Track
              layout={layout}
              selectedId={selectedId}
              onSelect={onSelect}
              label={`Events in ${name}. Use the arrow keys to move between them.`}
            />
            {cuts.length ? (
              <ul className="mt-2 space-y-0.5 text-xs font-medium text-danger">
                {cuts.map((cut) => (
                  <li key={`${cut.eventId}-${cut.edge}`}>
                    {cut.substantial ? "This cut" : "This cut slightly"} interrupts a spoken line at
                    the {cut.edge} of the clip ({formatSeconds(cut.cutMs)} falls outside).
                  </li>
                ))}
              </ul>
            ) : null}
            {index === 0 ? (
              <fieldset className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                <legend className="sr-only">Show in the list</legend>
                {LANES.map((lane) => (
                  <label key={lane.kind} className="flex cursor-pointer items-center gap-1">
                    <input
                      type="checkbox"
                      checked={kinds.has(lane.kind)}
                      onChange={() => toggleKind(lane.kind)}
                      className="accent-accent-ink"
                    />
                    {lane.label}
                  </label>
                ))}
              </fieldset>
            ) : null}
            <EventList
              layout={layout}
              kinds={kinds}
              selectedId={selectedId}
              onSelect={onSelect}
              label={`Script for ${name}`}
              timeline={timeline}
            />
            {truncatedFrom ? (
              <p className="mt-1 text-xs text-ink-muted">
                Showing the first {layout.events.length} of {truncatedFrom} events. Switch to Clip
                to see the part that matters.
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
