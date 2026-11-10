"use client";

import { useId, useRef, useState, type DragEvent } from "react";

import { formatFileSize, joinClasses } from "@/client/format";
import { UPLOAD_LIMIT_LABEL, checkUpload } from "@/client/upload-rules";
import type { WorkProfile } from "@/domain/estimate";
import { Button, buttonClass } from "@/components/ui/button";

import { PromoCount, type Summarize } from "./promo-count";

type UploadFormProps = {
  file: File | null;
  onFileChange: (file: File | null) => void;
  onAnalyze: (file: File, count: number) => void;
  /** Demo only: makes a made-up file so the workflow can run without one. */
  sampleFile?: () => File;
  /** For time and cost estimates. Null when this setup cannot estimate. */
  estimateProfile?: WorkProfile | null;
  /** Reads episode count and size for the estimate. The real ZIP reader unless replaced. */
  summarize?: Summarize;
};

/**
 * Picks one ZIP and holds it in memory. Nothing is sent anywhere until the
 * editor presses Find promos. The checks here only save a wasted trip: the
 * server inspects every archive itself.
 */
export function UploadForm({
  file,
  onFileChange,
  onAnalyze,
  sampleFile,
  estimateProfile = null,
  summarize,
}: UploadFormProps) {
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  function accept(files: readonly File[]) {
    const result = checkUpload(files);
    if (result.ok) {
      onFileChange(result.file);
      setError(null);
    } else {
      setError(result.message);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    accept([...event.dataTransfer.files]);
  }

  function remove() {
    onFileChange(null);
    setError(null);
    input.current?.focus();
  }

  const focusRing =
    "group-has-[input:focus-visible]:outline-2 group-has-[input:focus-visible]:outline-offset-2 group-has-[input:focus-visible]:outline-accent-ink";

  return (
    <div
      className="group mt-10"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={input}
        id={inputId}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        aria-describedby={error ? `${errorId} ${helpId}` : helpId}
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          accept([...(event.target.files ?? [])]);
          // Clears the value so picking the same file again still fires a change.
          event.target.value = "";
        }}
      />

      {file ? (
        <div
          className={joinClasses(
            "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-surface px-5 py-4",
            dragging ? "border-accent-ink" : "border-line",
          )}
        >
          <div className="min-w-0 flex-1 basis-48">
            <p className="font-medium [overflow-wrap:anywhere]">{file.name}</p>
            <p className="text-sm text-ink-muted tabular-nums">{formatFileSize(file.size)}</p>
          </div>
          <div className="flex items-center gap-4">
            <label
              htmlFor={inputId}
              className={joinClasses(
                "cursor-pointer rounded-sm text-sm font-medium text-accent-ink underline underline-offset-4 hover:no-underline",
                focusRing,
              )}
            >
              Replace file
            </label>
            <Button variant="quiet" onClick={remove}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <label
          htmlFor={inputId}
          className={joinClasses(
            "flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed px-6 py-12 text-center sm:py-14",
            dragging ? "border-accent-ink bg-accent/10" : "border-line-strong/60 bg-surface",
            focusRing,
          )}
        >
          <span className="text-lg font-medium">Drop your screenplay ZIP here</span>
          <span className="mt-1 text-sm text-ink-muted">or</span>
          <span className={joinClasses(buttonClass("primary"), "mt-3 px-5 py-2.5 text-base")}>
            Choose a file
          </span>
        </label>
      )}

      <p id={helpId} className="mt-3 text-sm text-ink-muted">
        One text file per episode, up to {UPLOAD_LIMIT_LABEL}. Nothing is uploaded until you press
        Find promos.
      </p>

      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {file ? (
        <PromoCount
          file={file}
          profile={estimateProfile}
          summarize={summarize}
          onFind={(count) => onAnalyze(file, count)}
        />
      ) : sampleFile ? (
        <p className="mt-4 text-sm text-ink-muted">
          Just exploring?{" "}
          <Button variant="quiet" onClick={() => accept([sampleFile()])}>
            Use the sample show
          </Button>
        </p>
      ) : null}
    </div>
  );
}
