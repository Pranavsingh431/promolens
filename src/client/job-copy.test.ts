import { describe, expect, it } from "vitest";

import { JOB_FAILURES, JOB_STAGES, analysisJobSchema } from "@/domain/analysis-job";

import { job } from "../../tests/support/analysis-service";
import { FAILURE_COPY, STAGE_COPY, describeServiceError } from "./job-copy";
import { ServiceError } from "./service";

describe("job wording", () => {
  it("covers every stage, in the order the contract runs them", () => {
    expect(STAGE_COPY.map((s) => s.id)).toEqual([...JOB_STAGES]);
  });

  it("covers every failure", () => {
    expect(Object.keys(FAILURE_COPY).sort()).toEqual([...JOB_FAILURES].sort());
  });

  it("uses plain language an editor can act on", () => {
    const text = JSON.stringify([STAGE_COPY, FAILURE_COPY]);
    expect(text).not.toMatch(/inference|pipeline|stage [A-G]\b|prompt|token|schema|ZDR/i);
    expect(text).not.toMatch(/\d+\s*%/);
  });
});

describe("service error wording", () => {
  it("shows the service's own reason for a rejected file", () => {
    const error = new ServiceError("invalid-file", "This ZIP has no text files.");
    expect(describeServiceError(error)).toEqual({
      title: "This file could not be used",
      message: "This ZIP has no text files.",
    });
  });

  it("does not blame the connection for a failure that is not about the connection", () => {
    for (const kind of ["not-found", "server", "invalid-response", "invalid-file"] as const) {
      expect(describeServiceError(new ServiceError(kind, "x")).title).not.toMatch(/contact/);
    }
    expect(describeServiceError(new ServiceError("network", "x", true)).title).toMatch(/contact/);
  });
});

describe("the job contract", () => {
  it("accepts a running job and a failure", () => {
    expect(analysisJobSchema.parse(job("parsing")).state).toBe("parsing");
    const failed = job("failed", {
      failure: { code: "invalid-archive", stage: "validating", retryable: false },
    });
    expect(analysisJobSchema.parse(failed).failure?.code).toBe("invalid-archive");
  });

  it("rejects a state the interface does not know", () => {
    expect(
      analysisJobSchema.safeParse(job("uploading", { state: "halfway" as never })).success,
    ).toBe(false);
  });
});
