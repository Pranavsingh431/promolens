import { describe, expect, it, vi } from "vitest";

import { fakeService, job, zipFile } from "../../tests/support/analysis-service";
import { createAnalysisRunner, type AnalysisSession } from "./analysis-runner";
import { ServiceError, type AnalysisService } from "./service";

function start(service: AnalysisService) {
  const seen: AnalysisSession[] = [];
  const runner = createAnalysisRunner(service, (session) => seen.push(session));
  const phases = () => seen.map((s) => s.phase);
  const until = (phase: AnalysisSession["phase"]) =>
    vi.waitFor(() => expect(seen.at(-1)?.phase).toBe(phase));
  return { runner, seen, phases, until };
}

const STAGES = [
  "uploading",
  "validating",
  "parsing",
  "discovering",
  "evaluating",
  "ranking",
] as const;

describe("following an analysis", () => {
  it("reports every state the service reports, then loads the results", async () => {
    const { runner, seen, until } = start(
      fakeService([...STAGES.map((s) => job(s)), job("completed")]),
    );
    runner.start(zipFile());
    await until("results");
    const reported = seen.flatMap((s) => (s.phase === "running" ? [s.job.state] : []));
    expect(reported).toEqual([...STAGES]);
  });

  it("shows partial runs as results and failed runs as stopped", async () => {
    const partial = start(fakeService([job("ranking"), job("partial")]));
    partial.runner.start(zipFile());
    await partial.until("results");

    const failed = start(
      fakeService([
        job("parsing"),
        job("failed", { failure: { code: "no-episodes", stage: "parsing", retryable: true } }),
      ]),
    );
    failed.runner.start(zipFile());
    await failed.until("stopped");
  });

  it("says plainly when analysis is not connected", async () => {
    const { runner, seen, until } = start(
      fakeService([job("uploading")], {
        startAnalysis: () => Promise.reject(new ServiceError("unavailable", "Not connected.")),
      }),
    );
    runner.start(zipFile("mine.zip"));
    await until("unavailable");
    expect(seen.at(-1)).toEqual({ phase: "unavailable", fileName: "mine.zip" });
  });

  it("rides out a brief connection problem without bothering the editor", async () => {
    let calls = 0;
    const base = fakeService([job("parsing"), job("completed")]);
    const { runner, phases, until } = start({
      ...base,
      getJob: (id, options) => {
        calls += 1;
        return calls <= 2
          ? Promise.reject(new ServiceError("network", "Lost.", true))
          : base.getJob(id, options);
      },
    });
    runner.start(zipFile());
    await until("results");
    expect(phases()).not.toContain("error");
  });

  it("asks what to do after repeated failures, and Try again resumes the same job", async () => {
    let healthy = false;
    let calls = 0;
    const base = fakeService([job("parsing"), job("completed")]);
    const startSpy = vi.fn(base.startAnalysis);
    const { runner, seen, until } = start({
      ...base,
      startAnalysis: startSpy,
      getJob: (id, options) => {
        calls += 1;
        return healthy
          ? base.getJob(id, options)
          : Promise.reject(new ServiceError("network", "Lost.", true));
      },
    });
    runner.start(zipFile());
    await until("error");
    expect(calls).toBe(3);
    expect(seen.at(-1)).toMatchObject({ phase: "error", canRetry: true });
    healthy = true;
    runner.retry();
    await until("results");
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("does not offer a retry for an error a retry cannot fix", async () => {
    const { runner, seen, until } = start(
      fakeService([job("parsing")], {
        getJob: () => Promise.reject(new ServiceError("not-found", "Gone.")),
      }),
    );
    runner.start(zipFile());
    await until("error");
    expect(seen.at(-1)).toMatchObject({ phase: "error", canRetry: false });
  });

  it("refuses results that do not match the contract, and shows nothing from them", async () => {
    const { runner, seen, until } = start(
      fakeService([job("completed")], {
        getResults: async () => ({ ranking: { nope: true }, promos: {} }) as never,
      }),
    );
    runner.start(zipFile());
    await until("error");
    expect(seen.at(-1)).toMatchObject({ error: { kind: "invalid-response" } });
    expect(seen.some((s) => s.phase === "results")).toBe(false);
  });

  it("cancels through the service and stops polling", async () => {
    let polls = 0;
    const base = fakeService([job("parsing", { canCancel: true, pollAfterMs: 5 })]);
    const { runner, seen, until } = start({
      ...base,
      getJob: (id, options) => {
        polls += 1;
        return base.getJob(id, options);
      },
    });
    runner.start(zipFile());
    await until("running");
    runner.cancel();
    await until("stopped");
    expect(seen.at(-1)).toMatchObject({ job: { state: "cancelled" } });
    const after = polls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(polls).toBe(after);
  });

  it("stops everything on reset", async () => {
    const { runner, until, seen } = start(fakeService([job("parsing", { pollAfterMs: 5 })]));
    runner.start(zipFile());
    await until("running");
    runner.reset();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.at(-1)?.phase).toBe("idle");
  });

  it("restarts with the same file", async () => {
    const base = fakeService([
      job("failed", { failure: { code: "internal", stage: "parsing", retryable: true } }),
    ]);
    const startSpy = vi.fn(base.startAnalysis);
    const { runner, until } = start({ ...base, startAnalysis: startSpy });
    const file = zipFile();
    runner.start(file);
    await until("stopped");
    runner.restart();
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2));
    expect(startSpy.mock.calls[1]?.[0]).toBe(file);
  });
});

describe("coming back to an analysis", () => {
  it("opens one that already finished, without any upload", async () => {
    const startAnalysis = vi.fn();
    const { runner, phases, until } = start(
      fakeService([job("completed")], { startAnalysis, getJob: async () => job("completed") }),
    );
    runner.open("job-1");
    await until("results");
    expect(startAnalysis).not.toHaveBeenCalled();
    expect(phases()[0]).toBe("opening");
  });

  it("picks up one that is still running", async () => {
    const states = [job("ranking"), job("ranking"), job("completed")];
    let index = 0;
    const getJob = async () => states[Math.min(index++, 2)] as ReturnType<typeof job>;
    const { runner, seen, until } = start(fakeService(states, { getJob }));
    runner.open("job-1");
    await until("results");
    expect(seen.some((s) => s.phase === "running")).toBe(true);
  });

  it("shows a failed one as stopped, with its reason", async () => {
    const failed = job("failed", {
      failure: { code: "interrupted", stage: "ranking", retryable: true },
    });
    const { runner, seen, until } = start(fakeService([failed], { getJob: async () => failed }));
    runner.open("job-1");
    await until("stopped");
    expect(seen.at(-1)).toMatchObject({ job: { failure: { code: "interrupted" } } });
  });

  it("says plainly when an analysis is gone", async () => {
    const getJob = async () => {
      throw new ServiceError("not-found", "Gone");
    };
    const { runner, seen, until } = start(fakeService([job("queued")], { getJob }));
    runner.open("job-1");
    await until("error");
    expect(seen.at(-1)).toMatchObject({ error: { kind: "not-found" }, canRetry: false });
  });
});

describe("trying again", () => {
  const failed = job("failed", {
    failure: { code: "provider-unavailable", stage: "ranking", retryable: true },
  });

  it("reruns on the server instead of uploading again, when it can", async () => {
    const retryJob = vi.fn(async () => job("completed"));
    const startAnalysis = vi.fn(async () => failed);
    const { runner, until } = start(fakeService([failed], { retryJob, startAnalysis }));
    runner.start(zipFile());
    await until("stopped");
    runner.restart();
    await until("results");
    expect(retryJob).toHaveBeenCalledWith("job-1");
    expect(startAnalysis).toHaveBeenCalledOnce();
  });

  it("uploads again when the service has no retry", async () => {
    const startAnalysis = vi.fn(async () => failed);
    const { runner, until } = start(fakeService([failed], { startAnalysis }));
    runner.start(zipFile());
    await until("stopped");
    runner.restart();
    await vi.waitFor(() => expect(startAnalysis).toHaveBeenCalledTimes(2));
  });
});

describe("a hidden tab", () => {
  it("does not ask the server anything until it is visible", async () => {
    let release = () => {};
    const visible = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getJob = vi.fn(async () => job("completed"));
    const seen: AnalysisSession[] = [];
    const runner = createAnalysisRunner(
      fakeService([job("ranking")], { getJob }),
      (session) => seen.push(session),
      { whenVisible: () => visible },
    );
    runner.start(zipFile());
    await vi.waitFor(() => expect(seen.at(-1)?.phase).toBe("running"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getJob).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(seen.at(-1)?.phase).toBe("results"));
    expect(getJob).toHaveBeenCalled();
  });
});
