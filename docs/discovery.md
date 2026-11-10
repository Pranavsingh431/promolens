# AI candidate discovery

Discovery asks a model to find promo moments in one episode at a time. The
model points at events by number. Code turns those numbers into exact clip
boundaries, checks every rule from the brief, and rejects what it cannot fix.
The model never supplies a timestamp.

Status: built, tested against a local mock of the OpenRouter API, and run on
the full 50-episode pack on 2026-11-10. See
[Results of the first full run](#results-of-the-first-full-run).

## Flow

1. **Plan routing.** Read OpenRouter's public zero-data-retention endpoint
   list and keep only the endpoints that are allowed for the chosen model (see
   [Privacy](#privacy)). If none are left, stop.
2. **Build the prompt** for each episode from the parsed screenplay.
3. **Call the model** once per episode with a strict JSON schema, then
   validate the answer locally with Zod.
4. **Resolve** each proposal into a candidate clip with the same boundary
   rules the baselines use.
5. **Save** the AI candidate set in the same format as the baselines, so the
   evaluation tools treat every method the same way.
6. **Merge** the AI set with the cue and uniform baselines into a hybrid pool,
   without losing where each clip came from.

## Privacy

The screenplays are confidential. Every request is sent with these provider
preferences:

| Setting              | Value                     | Effect                                                         |
| -------------------- | ------------------------- | -------------------------------------------------------------- |
| `zdr`                | `true`                    | Only zero-data-retention endpoints.                            |
| `data_collection`    | `"deny"`                  | No provider that may train on or keep prompts.                 |
| `require_parameters` | `true`                    | No provider that would silently ignore the JSON schema.        |
| `only`               | the allowed endpoint tags | Routing, including fallbacks, stays inside this list.          |
| `allow_fallbacks`    | `true`                    | If one allowed endpoint is down, another allowed one is tried. |

"Allowed" means the endpoint is on the zero-data-retention list, supports
structured outputs and `response_format`, is not marked as down, and has
`safety_retention` set to false. Google's Safety Retention endpoints may keep
flagged prompts for abuse review, so they are excluded by default. A run can
accept them only with `--allow-safety-retention`, and the choice is recorded in
the run manifest and in the method version of every candidate.

Requests never include tools, plugins, or web search, and `:online` model
variants are refused.

### Before the first live run

Request settings cannot turn off logging that is enabled on the account
itself, and OpenRouter has no API for reading those account settings. Before
sending any screenplay, a person signed in to the account must check:

- **Settings, Privacy:** input and output logging is off, and no option that
  shares prompts or allows training is on.
- **Observability (or Logs):** no integration that copies prompts or
  completions to another service.

Record the date of that check in the private run notes. The discovery command
cannot verify it.

## Model

The default is `anthropic/claude-haiku-5.5` with low reasoning effort and a
12,000-token output limit shared by reasoning and the answer. On 2026-11-10 it
was the cheapest model we found with strict zero-data-retention endpoints that
support structured outputs (Google Vertex, global, US, and EU). Gemini 3.1
Flash Lite, the first model considered, was offered only on Safety Retention
endpoints, so it is not used by default.

Change the model with `--model` or `PROMOLENS_DISCOVERY_MODEL`. The routing
check runs again for whatever model is chosen.

## Prompt

The prompt lives in `src/domain/discovery/prompts/discovery-v1.ts`. Any change
to its text needs a new prompt version, and the cache key includes a hash of
the full prompt anyway.

Two variants exist so their value can be measured:

- `writer-context` adds the logline and continuity notes, marked as writer
  notes that a viewer never sees.
- `screen-only` sends only what happens on screen.

Each event is one line: `#number start-end TYPE Speaker: text`. Screenplay
text is treated as untrusted data. It sits inside `<screenplay>` tags, any text
that looks like those tags is replaced before sending, and the system prompt
says that instructions inside the screenplay are part of the story.

## Output contract

The model returns up to 12 proposals per episode. Each names a start event, an
end event, hook events, cliffhanger events, supporting events, a hook type,
one sentence each for the hook, the cliffhanger, and why it works, any context
a new viewer would need, and warnings from a fixed list. The JSON schema is in
`src/domain/discovery/proposal.ts`. Limits that some providers' strict modes
reject, such as array lengths, are checked in Zod instead.

## Turning proposals into clips

`src/domain/discovery/resolve.ts` (version `resolve-1`) applies these rules in
order and records every change:

1. Widen the clip to contain the hook and cliffhanger events.
2. If the hook starts more than 3 s in, trim the setup, unless the model
   marked an earlier event as needed.
3. If more than 2 s follows the cliffhanger, trim it, unless the model marked
   a later event as needed.
4. Fix the length only in ways that keep the hook inside the first 3 s and the
   cliffhanger last.
5. Move edges off a spoken line, onto a nearby shot change, only when that
   keeps rules 1 to 4.

A proposal is rejected, with a reason, when it points at events that do not
exist, its anchors are reversed, it has no valid hook or cliffhanger event, no
legal length exists, it repeats another proposal, or it is beyond the
proposal limit. Proposals that cite unknown event numbers are counted
separately as a sign of invented references.

## Merging and the hybrid pool

`src/domain/discovery/merge.ts` (version `merge-1`) treats two clips as the
same moment only when they overlap heavily in time (IoU at least 0.7) and
share most of their story events (Jaccard at least 0.6, camera directions
ignored). Clips that overlap but tell different moments stay apart.

The hybrid pool keeps every group that has an AI or cue candidate. Uniform
windows are added only for episodes where nothing else exists. Each hybrid
clip lists its sources. Its order is provisional until ranking is built.

## Cost, limits, and failures

- **Spending cap.** Before each attempt, the worst case is reserved: an upper
  bound on prompt tokens at the highest input price among allowed endpoints,
  plus the full output limit at the highest output price. The bound counts
  the system prompt, the screenplay, and the JSON schema at 1.5 characters
  per token. The first live call measured about 2.2, so the bound has a wide
  margin. The reservation is replaced by the billed cost when the answer
  arrives. A request that could break the budget is not sent.
- **Request cap.** Defaults to 3 per episode.
- **Concurrency.** Defaults to 2 requests at a time.
- **Timeouts and retries.** 120 s per attempt, up to 3 attempts, exponential
  backoff with jitter, and `Retry-After` honoured up to 2 minutes. A refusal
  or a truncated answer fails only that episode. Problems that would fail
  every episode, such as a bad key, no credit, an invalid request, or no
  eligible endpoint, stop the run at once.
- **Costs** are taken from the billed cost OpenRouter returns. When none is
  returned, an estimate from token counts is shown and labelled as such.
- **Dry run.** `--dry-run` makes no network calls and estimates the worst case
  from a dated price snapshot.

## Cache and resume

Validated answers are cached under `private/discovery/cache`. The key is a
hash of the episode's events (and writer notes for `writer-context`), the full
prompt, the JSON schema, the prompt and schema versions, the model, the token
limit, the reasoning effort, and the privacy mode. Failed or invalid answers
are never cached. A damaged cache file is treated as a miss and reported.

`--resume` repeats the last run's settings and sends only the episodes it did
not finish. `--fresh` ignores the cache, and a later `--resume` of that run
keeps ignoring entries older than it.

## Usage

```bash
npm run discover -- pack.zip --episodes 2 --dry-run
npm run discover -- pack.zip --split development
npm run discover -- pack.zip --split development --variant screen-only
npm run discover -- pack.zip --all --budget 2
npm run discover -- pack.zip --resume
```

The key is read from `OPENROUTER_API_KEY`, or from `.env` when that variable is
not set. Exit code 0 means every requested episode was processed, 1 means some
failed or were skipped, and 2 is a usage or setup error.

Output, all under the git-ignored `private/` folder:

| Path                                              | Contents                                                     |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `private/discovery/runs/<run>/manifest.json`      | Settings, routing, per-episode status, usage, cost, latency. |
| `private/discovery/runs/<run>/proposals.json`     | Each proposal and what resolution did with it.               |
| `private/discovery/last-run.json`                 | What `--resume` repeats.                                     |
| `private/evaluation/candidates/ai-<variant>.json` | The AI candidate set.                                        |
| `private/evaluation/candidates/hybrid.json`       | The merged pool.                                             |

The command prints counts, costs, and error kinds. It never prints screenplay
text, prompts, or model output. Error messages from providers are cut to 160
characters.

## Results of the first full run

Run on 2026-11-10 with the default model and settings, after the account
check above. The prompt was not changed during or after the run. These are
measured numbers. None of them says whether a clip is a good promo, because
no editor labels exist yet.

| Measure                                   | writer-context | screen-only |
| ----------------------------------------- | -------------- | ----------- |
| Episodes processed                        | 50/50          | 50/50       |
| Episodes with at least one valid clip     | 49/50          | 45/50       |
| Proposals                                 | 114            | 131         |
| Valid clips after resolution              | 107 (94%)      | 105 (80%)   |
| Rejected as too short / too long          | 2 / 5          | 18 / 8      |
| Proposals citing events that do not exist | 0              | 0           |
| Clips with an adjusted boundary           | 72             | 67          |
| Median clip length                        | 34.9 s         | 33.7 s      |
| Billed cost, all runs                     | $0.081         | $0.077      |
| Median latency per episode                | 10.7 s         | 9.8 s       |

All 212 AI clips passed the independent structural checks used for the
baselines. Some start or end mid-shot. Three keep an edge inside a spoken
line, where lines overlap in the source: in the two outside the held-out set,
by 0.2 and 0.8 s, and moving the edge would have pushed the hook past 3 s or
put a new line after the cliffhanger. The checks report these as warnings.

The two variants found 161 distinct moments. They agreed on 47. 81 match a
clip from the cue baseline, and 80 are moments the cue baseline missed. The
hybrid pool has 252 clips and covers all 50 episodes.

Total cost for the smoke test, the development pilot, and both full runs was
$0.158 for 108 requests: 658,000 input tokens and 185,000 output tokens, of
which 100,000 were reasoning. The model returns 1 to 6 proposals per episode,
usually 2 or 3, well under the limit of 12, so recall depends on the hybrid
pool.

Two fixes came out of the live runs:

- The spending bound counted too few prompt tokens. Screenplay prompts run at
  about 2.2 characters per token, not 3, and the JSON schema was not counted.
  The guard still held, because the reserved output dominates, but the bound
  now uses 1.5 characters per token and includes the schema.
- The local check allowed at most 40 positive numbers in each event list,
  limits the schema sent to the model does not state. In 26 of the 50 episodes a 60-second window holds
  more than 40 events. One episode failed all three attempts on an event list, and
  other episodes needed retries whose causes were not recorded. The cap is now
  a runaway guard of 1,000, and event numbers are judged only during
  resolution. Error messages now name the failed check.

## Evaluating discovery

The AI sets and the hybrid pool are ordinary candidate sets, so
`npm run eval -- metrics pack.zip --split development` and
`npm run eval -- report pack.zip --split development` compare them with the
baselines. Until editor labels exist, that comparison covers structure only:
how many clips pass the structural checks, which checks fail (hook timing,
spoken lines cut in half, length, and the rest), duplicates, and how many
episodes have at least one valid clip. The discovery manifest adds rejection
reasons, invented event references, and boundary changes. None of this says
whether the clips are good promos.

Prompt changes are studied on the development episodes only. The held-out
episodes are run as part of the full show but are never read to tune the
prompt. See [Evaluation methodology](evaluation.md).

## Tests

Unit tests cover the prompt, the output schema, resolution, merging, routing,
limits, the client, and the cache. An integration test runs the command
against a local mock of the OpenRouter API, including resume, a damaged cache,
budget refusal, and a model with only Safety Retention endpoints. A test setup
file fails any request to a host other than this machine, so no test can reach
a real model.
