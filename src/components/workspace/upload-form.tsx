"use client";

import { useId, useRef, useState, type DragEvent } from "react";

import { formatFileSize, joinClasses } from "@/client/format";
import { UPLOAD_LIMIT_LABEL, checkUpload } from "@/client/upload-rules";
import { Button } from "@/components/ui/button";

type UploadFormProps = {
  file: File | null;
  onFileChange: (file: File | null) => void;
  onAnalyze: (file: File) => void;
  /** Demo only: makes a made-up file so the workflow can run without one. */
  sampleFile?: () => File;
};

/**
 * Picks one ZIP and holds it in memory. Nothing is sent anywhere until the
 * editor presses Analyze. The checks here only save a wasted trip: the server
 * inspects every archive itself.
 */
export function UploadForm({ file, onFileChange, onAnalyze, sampleFile }: UploadFormProps) {
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
      className="group mt-8"
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
            "flex flex-wrap items-center gap-x-4 gap-y-3 rounded-md border bg-surface px-4 py-4",
            dragging ? "border-accent-ink" : "border-line-strong",
          )}
        >
          <div className="min-w-0 flex-1 basis-48">
            <p className="font-medium [overflow-wrap:anywhere]">{file.name}</p>
            <p className="font-mono text-xs text-ink-muted">{formatFileSize(file.size)}</p>
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
            "flex cursor-pointer flex-col items-center rounded-md border-2 border-dashed px-6 py-12 text-center",
            dragging ? "border-accent-ink bg-accent/10" : "border-line-strong bg-sunken",
            focusRing,
          )}
        >
          <svg
            viewBox="0 0 24 24"
            width="28"
            height="28"
            aria-hidden="true"
            focusable="false"
            className="text-ink-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 15V4" />
            <path d="M7.5 8.5 12 4l4.5 4.5" />
            <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
          </svg>
          <span className="mt-3 font-medium">Drop a ZIP of episode screenplays here</span>
          <span className="mt-1 text-sm text-accent-ink underline underline-offset-4">
            or choose a file
          </span>
        </label>
      )}

      <p id={helpId} className="mt-2 text-sm text-ink-muted">
        One timestamped text file per episode, up to {UPLOAD_LIMIT_LABEL}. Nothing is uploaded until
        you press Analyze.
      </p>

      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-4">
        {file ? <Button onClick={() => onAnalyze(file)}>Analyze screenplays</Button> : null}
        {sampleFile && !file ? (
          <Button variant="secondary" onClick={() => accept([sampleFile()])}>
            Use the sample show
          </Button>
        ) : null}
      </div>
    </div>
  );
}
