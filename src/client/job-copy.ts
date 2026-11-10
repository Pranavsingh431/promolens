import type { JobFailureCode, JobStage } from "@/domain/analysis-job";

import type { ServiceError, ServiceErrorKind } from "./service";

/** The stages in the order they run, in words an editor would use. */
export const STAGE_COPY: ReadonlyArray<{ id: JobStage; label: string; description: string }> = [
  { id: "uploading", label: "Upload", description: "Sending your screenplay file." },
  { id: "validating", label: "Check the file", description: "Making sure the ZIP can be read." },
  { id: "parsing", label: "Read episodes", description: "Reading every episode and its timing." },
  {
    id: "discovering",
    label: "Find moments",
    description: "Finding promising moments across your episodes.",
  },
  {
    id: "evaluating",
    label: "Evaluate moments",
    description: "Checking each moment's opening, ending, and clarity for a new viewer.",
  },
  {
    id: "ranking",
    label: "Rank promos",
    description: "Comparing the strongest moments and choosing which to post first.",
  },
];

export const FAILURE_COPY: Record<JobFailureCode, { title: string; message: string }> = {
  "invalid-archive": {
    title: "This ZIP could not be read",
    message:
      "The file may be damaged or may not hold screenplay text files. Check it and try again.",
  },
  "unsupported-format": {
    title: "These screenplays could not be read",
    message: "Some files in the ZIP are not in the timestamped format PromoLens reads.",
  },
  "no-episodes": {
    title: "No episodes were found",
    message: "The ZIP opened, but nothing in it looked like a timestamped episode screenplay.",
  },
  "too-large": {
    title: "This show is too large",
    message: "Split it into smaller ZIP files and analyze each one.",
  },
  "provider-unavailable": {
    title: "The AI service is not responding",
    message: "Nothing is wrong with your file. Try again in a few minutes.",
  },
  "model-output-invalid": {
    title: "The AI answers could not be used",
    message: "Nothing is wrong with your file. Try again in a few minutes.",
  },
  "budget-reached": {
    title: "The analysis limit was reached",
    message: "This run stopped at its spending limit before finishing.",
  },
  "storage-unavailable": {
    title: "Your file could not be reached",
    message: "It may not have finished saving. Try again, or upload it again.",
  },
  "missing-result": {
    title: "These results are no longer available",
    message: "Start the analysis again to rebuild them.",
  },
  "workflow-start": {
    title: "The analysis could not start",
    message: "Nothing is wrong with your file. Try again in a moment.",
  },
  interrupted: {
    title: "The analysis was interrupted",
    message: "Finished work is saved, so trying again picks up where it stopped.",
  },
  internal: {
    title: "The analysis stopped unexpectedly",
    message: "Something went wrong on our side. Try again.",
  },
};

const SERVICE_ERROR_COPY: Record<ServiceErrorKind, { title: string; message: string | null }> = {
  unavailable: { title: "Analysis is not connected yet", message: null },
  network: {
    title: "We lost contact with the analysis",
    message: "Check your connection and try again.",
  },
  // The service explains what was wrong with the file, so its own message is shown.
  "invalid-file": { title: "This file could not be used", message: null },
  "not-found": {
    title: "This analysis is no longer available",
    message: "Start again with your file.",
  },
  server: {
    title: "The analysis service had a problem",
    message: "Nothing is wrong with your file. Try again in a few minutes.",
  },
  "invalid-response": {
    title: "These results could not be read",
    message: "They did not match the expected format, so they are not shown.",
  },
  unauthorized: {
    title: "Please sign in again",
    message: "Your session has ended. Your analyses are saved.",
  },
  "rate-limited": {
    title: "Too many requests",
    message: "Wait a minute and try again.",
  },
};

export function describeServiceError(error: ServiceError): { title: string; message: string } {
  const copy = SERVICE_ERROR_COPY[error.kind];
  return { title: copy.title, message: copy.message ?? error.message };
}
