# Automatic memory: pinned local source investigation

Development baseline: 94c51c7 (v0.7.5). Branch: feature/automatic-memory. No runtime profile changes.

## Reference checkouts

References live under /root/memory-reference-audit. A successful fetch of HEAD is not evidence of a completed checkout. Partial-clone transfers for Letta/Claude-mem remain incomplete; selected files were materialized via git show at the recorded commit into excerpts/. No upstream build scripts or applications were run.

| Project | Pinned HEAD | Inspected code |
|---|---|---|
| Mem0 | f1791daa86d469249c9b002f62644d58a1eb96a0 | mem0/memory/main.py:932–971 |
| Basic Memory | fb4f4c861a90b16742b2ab2e3437726cc351aafa | test-int/mcp/test_compact_search_integration.py:12–73; src/basic_memory/mcp/tools/search.py |
| Graphiti | ed23196506eba8806fae6da831d73fcd2ad714d8 | graphiti_core/search/search_config_recipes.py:33–53; search_filters.py:55–73 |
| Letta Code | a24b294aa19ed6c51cea4f68e1a36d90526fe700 | src/agent/subagents/memory-worker.ts:21–95; corresponding test file extracted, not yet reviewed |
| Claude-mem | 0c488b54e761d7f6f4091b3a6e1958712f13b19d | src/integrations/dsh-plugin/hooks.ts:28–99; src/cli/spool-hook-event.ts:27–82 |

Read license headers: Graphiti and extracted Claude-mem LICENSE are Apache-2.0. All other full license checks remain required before copying code. This plan borrows patterns only; no upstream source is copied into the runtime.

## Findings established by source

- Mem0 runs single-call extraction with existing memories + new messages and reports inference failure distinctly from successful empty extraction (main.py:942–971). Benefit: memory writing can leave the primary conversational agent. Cost: this still consumes a separate inference budget; it is not free memory.
- Basic Memory compact search tests strip prose while preserving ranked identities, then read selected full notes. The test asserts compact JSON is less than one third of full JSON on its fixture (:39–66). Borrow discovery/read separation and test output bytes; do not claim that ratio for our workloads.
- Graphiti explicitly combines BM25 + cosine with RRF (:33–53), and offers valid_at/invalid_at/created_at/expired_at filters. Borrow evidence time and validity fields before adopting expensive graph/vector infrastructure.
- Letta background memory worker has agent/conversation scope, abort signal, checkout ownership and completion/sync semantics. It runs outside the primary turn. Borrow explicit background task ownership; integration into this Host still requires exact Service contracts.
- Claude-mem DSH adapter makes context injection, ingestion and summarization independently configurable. Its tool observation skips isError and filters tool names (:68–75); its post-execute hook launches observation without awaiting (:36–40). Our error-oriented workflow must retain failures and avoid assuming this pattern provides crash-safe ingestion.
- Claude-mem spool implementation limits delivery, validates exact receipts and preserves rejected/unacknowledged records (:40–82). Borrow durable per-event IDs, bounded processing and explicit pending/failed states, not unbounded fire-and-forget.

## Proposed implementation stages

1. Automatic deterministic event ledger: allowlisted tool outcome metadata, session/call/workspace references, failure and subsequent success observation, idempotent inserts. No raw commands or outputs, no added system prompt, no inference.
2. Candidate episodes: associate bounded observations by session/tool/turn. A later success is only an observed recovery, not proof of root cause or successful final task. Expose unknown linkage instead of fabricating a solution.
3. Optional background extractor: explicit model route, timeout/token/batch limits, durable jobs, leases and cancellation. Takes compact evidence references, writes candidates with source IDs. Failure retries are bounded. No primary-agent reflection task by default.
4. Retrieval: compact identity-first candidates, project scoping, relevance threshold, duplicate suppression and hard byte/token budgets. No automatic injection until current Host logging/injection contracts are verified. Existing meow and case injection must not duplicate each other.
5. Verified promotion: source-linked evidence, user/model-reported versus mechanically observed status; automatic summaries never become verified fixes without a real oracle. Compare saved tokens against capture/extraction/retrieval overhead on repeat-task fixtures.

## Current implementation plan and goals

| Stage | Goal | Status |
|---|---|---|
| A | Pin local references and record code-level findings | Done; see fixed SHAs and source ranges above |
| B | Capture bounded tool outcome metadata, no prompt or raw output | Done; source events are idempotent |
| C | Derive source-linked failure episodes and enqueue per turn | Done; bounded, scoped, cursor-deduplicated |
| D | Read only allowlisted recorded result text with workspace/session checks | Done as Host session adapter; live profile test still required |
| E | Explicit, bounded Host LLM stream adapter with citations | Done as adapter; provider/model must be explicitly configured |
| F | Lease/retry queue, persist candidates, return short scoped summaries | Done locally; 1s/2s backoff (60s cap), max three attempts, fixed failure code, workspace-scoped candidate_search/read |
| G | Connect Host lifecycle; teardown awaits worker | Done in development branch; simulated Host test, not live verification |
| H | Context budget/retrieval measurement | Offline 10-candidate fixture: 7,121→844 chars (88.1% reduction). Synthetic 8-query ranking: Recall@3=1.0, MRR=0.875, ranks=[2,1,2,1,1,1,1,1]; two similar error cases rank second. Malformed candidate JSON is skipped on search and returns null on read. Real tokenizer tokens, provider cost/latency and generated-answer quality remain pending; no live model run |
| I | Verify reference licenses and record checkout completeness | Licenses read from all five pinned HEADs: Mem0 Apache-2.0, Basic Memory AGPL-3.0, Graphiti/Letta Code/Claude-mem Apache-2.0. Basic Memory/Graphiti working trees complete; selected files and LICENSE blobs for Mem0/Letta/Claude-mem extracted via git show. Their working trees remain partial; no code copied |
| J | Final package metadata, README/CHANGELOG, security review, 0.8.0 candidate | Docs/package list synchronized on this branch; production-ready gate remains pending Host runtime validation and cost/quality study |

Hard gates: no generated candidate may be marked verified solely because a tool returned normally; real Host lifecycle tests and provider usage measurements must be clearly distinguished from local mocks. Provider cost/quality benchmarking has not been run and needs a named provider/model plus explicit user approval for potentially billable calls. No runtime install/restart or main merge/tag without separate explicit user approval.

## Acceptance criteria

- No growth in existing promptText or tool schema budgets.
- Repeat tools/result does not create duplicate observations.
- Raw arguments/output never persist in metadata mode.
- Failed execution and nonzero application exit are distinct from outcome unknown.
- Session/workspace boundaries hold even with concurrent calls.
- Automatic candidates never claim a fix from a success flag alone.
- Queue capacity and retention are explicit; storage failure does not break the original tool.
- Unit/Host-integration tests report separate evidence. Upstream test files read during research are not tests we ran.

## Sources

https://github.com/mem0ai/mem0
https://github.com/basicmachines-co/basic-memory
https://github.com/getzep/graphiti
https://github.com/letta-ai/letta-code
https://github.com/thedotmack/claude-mem

## Stage 1 implemented (development only)

`CaseStore.observe` records allowlisted outcome metadata at tools/result: failed/returned/unknown, session/call/workspace/tool and bounded symbolic error codes. It does not inspect arguments, value or content. Captures of memory_* and shared_cases are excluded. Duplicate session/call pairs are ignored. Observations use a rolling 10,000-row window; oldest transient rows are evicted atomically, while cases/candidates are separate. `automaticCapture:false` disables capture. Evidence is redacted and control-character cleaned, then fenced as untrusted text for extraction; this is mitigation, not a complete prompt-injection defense.

Verification: complete local Node suite 78/78 passed; new tests exercise output getters that throw if accessed, opaque error-code rejection, persistence, duplicate calls and no case promotion. An existing privacy test was flaky because it searched for `abc` anywhere in random UUIDs; it now checks the actual secret marker and the metadata key set. Runtime profile was not changed. Remaining gaps: rotation/retention, efficient capacity accounting, concurrent capacity enforcement and trajectory consumption.

## Stage 2: bounded episode projection

`CaseStore.episodes(workspace, session)` folds at most 200 stored observations into at most ten failure episodes. It retains failureCall and laterReturnedCall references, never raw outputs. Only a later return of the same tool closes a temporal episode; unrelated tools do not. Status is `later-return-observed`, taskVerified remains false, and no solution is generated. This is a deterministic projection of stored events, not proof the same command was retried or the underlying issue was fixed. Both row-window and candidate truncation are explicit.

Verification: 79/79 local tests passed. Episode test covers exact call references, unrelated-tool exclusion, project/session isolation and absence of fabricated solution fields. No additional model-facing schema or system-prompt text was added. Background model extraction and automatic context injection remain unimplemented.

## Stage 3a: durable handoff at the turn boundary

The inspected Host agent/turn-stopping serial event is used only to enqueue compact episode metadata; no steering or model request is sent. memory_jobs is deduplicated by workspace/session/latest observation row, capped at 1,000 jobs with 16 KB payloads. Jobs stay `awaiting-extractor`, and reopening the database preserves deduplication. automaticCapture:false also disables enqueueing. No worker lease, inference retry or route is claimed implemented yet.

Host llm.stream and GenerateOptions were inspected: explicit provider/model, maxTokens and AbortSignal are available. Background extraction still requires evidence-content access plus strict model output validation; the current metadata intentionally cannot reconstruct a root cause or patch. Implementation must not fabricate a solution from tool names/error codes.

Verification: full local suite 80/80. Queue test proves persistence, cursor deduplication, workspace filtering, payload ceiling on the fixture, and no promotion into cases. No live Host integration test or paid model call was run.

## Stage 3b: deterministic local queue consumer

At a turn boundary, after enqueueing, a local worker consumes at most one pending job and writes a compact `metadata-summary` (8 KB ceiling), retaining source call IDs and `taskVerified:false`. State becomes `summarized-metadata`, not a verified case. The work is synchronous and short, under a SQLite transaction; an interrupted transaction rolls back. It is not an async LLM worker and has no network/token cost. `automaticSummary:false` disables consumption. Full suite 81/81; tests prove one-time consumption, reopening state, source preservation and no case promotion.

Outstanding: content hydration with consent/filters, async model extraction with budgets, scoped summary retrieval, live Host tests, upstream license completion. No prompt injection or inference was enabled.

## Stage 3c: scope and duplicate controls

Episode enqueue now rejects identical payloads in the same workspace/session even when unrelated later calls advance the observation cursor. Queue consumption accepts workspace/session so one turn cannot consume another workspace's job. `awaiting-extractor` jobs remain local metadata summaries; no prompt, provider call or case promotion is introduced.

Verification: 82/82 tests. Added regression coverage for unrelated success not requeueing old failures and caller scope isolation. All edits remain on feature/automatic-memory; no runtime profile changes.

## Stage 3d: opt-in extractor validation boundary

lib/extraction.js accepts only an explicitly supplied extractor and evidence list; no route is discovered or called automatically. Bounds: 1–10 unique evidence IDs, 2,000 chars per item, 8 KB total input, requested maxTokens 256, 1 KB summary output, timeout 1–30,000 ms. Rejects unknown output fields and fabricated source IDs. Output is always candidate/taskVerified:false/trustedInstructions:false. It does not persist or inject generated text.

Full local suite 85/85. Cancellation/timeout tests prove caller waiting ends; underlying inference must honor AbortSignal—an uncooperative supplied function cannot be forcibly terminated by this boundary. maxTokens is a request to the extractor, not independently measured provider usage. Live provider execution, sanitized evidence hydration and Host-owned async draining remain not implemented. These are required before enabling automatic semantic extraction.

## Stage 3e: explicit Host LLM stream adapter

lib/host-extractor.js adapts the inspected llm.stream GenerateOptions contract to extractCandidate: explicit provider/model, no tools, bounded 4 KB response buffer, require finish.kind=stop. Rejects provider error/aborted/max-tokens/tool-calls and fabricated citations through the shared validation boundary. Instructions treat evidence as untrusted diagnostic data. No adapter is registered or invoked automatically, no live provider call was made, and the input remains caller-supplied filtered evidence. Full local regression 87/87 including simulated Host streams. The adapter has not yet been connected to the Host-owned asynchronous queue lifecycle.

## Stage 3f: scoped evidence hydration boundary

lib/evidence.js reads only a validated allowlist of 1–10 source IDs through an explicitly supplied workspace/session reader. Rejects unauthorized/duplicate IDs before any read, missing or oversized text and batches over 8 KB; checks cancellation and masks common token/Bearer/password patterns. It does not persist source text or infer that the supplied reader enforces authorization. Real Host session-log resolution is still required. Secret masking is deliberately documented as incomplete.

Full regression: 88/88 local tests; no upstream suites or live model calls run. Runtime profile and main unchanged.

## Delivery status at the time of this note

The following continuation sections supersede this snapshot. At this point the pipeline was incomplete; later rounds added Host session evidence, a leased queue worker, candidate persistence/retrieval and a Host turn-stopping hook. Remaining gates are tracked in the current plan below; do not use this historical snapshot as current status.

## Integration continuation: Host session evidence

Inspected live sessions Service: get(id), Session.header.cwd, seq and snapshotEvents(from,to); tool/call.data.callId/name and tool/result.data.message.toolCallId/content. sessionEvidenceReader uses this exact shape, validates session/workspace, allowlists tool names and scans at most 1,000 event positions. It never reads tool arguments or arbitrary files; missing/oversized results stop extraction. Local suite 90/90 passed, with test Session objects. No live profile activation or inference call was performed.

## Integrated leased worker (development)

runMemoryJob connects hydration, validated extraction, candidate persistence and scoped candidate retrieval. claimExtraction uses one atomic UPDATE RETURNING with a 35s lease, stale-lease fencing and at most three attempts. failExtraction stores a fixed failure category rather than raw model/provider errors. Candidate rows remain in memory_jobs and do not enter verified cases. candidateSummaries returns at most three 180-character snippets from the current workspace's latest 100 candidates. It is currently an internal store method, not a registered model tool or automatic prompt injection; a user-facing read action remains pending.

Full local suite 92/92 passed. Tests cover failed tool → queue → explicit evidence/extractor → persistence → search, stale lease rejection and retry exhaustion. This is an injected integration test, not a live Host or model test. Still needed before final delivery: plugin-owned async scheduling/drain and teardown; CLI discovery/read for candidates; docs/config verification and cost fixture. Runtime profile/main untouched.

## Stage 3g: Host lifecycle integration (opt-in)

apply listens to the verified serial `agent/turn-stopping` event. It enqueues and performs bounded local summary, then runs at most one leased extraction for the same workspace/session. Extraction is disabled unless both `automaticProvider` and `automaticModel` are explicitly set; there is no default/free route and no primary-agent message. `automaticTools` is an explicit allowlist for recorded tool results. The worker is serialized and the plugin effect awaits it before closing SQLite.

The Host adapter uses `ctx.get('llm').stream` and `ctx.get('sessions')`; session evidence checks header.cwd and resolves exact tool/call/result references, scans at most 1,000 event positions, and reads text only. The injected Host test verifies default-off and explicit route behavior, one candidate persisted, and awaited teardown. Full local suite 94/94.

No real model request was sent. Provider cost depends on the explicitly selected route. `maxTokens=256` is a request budget, not measured billing evidence. Existing meow-memory reflection remains independently active if that plugin is installed; this development plugin does not disable or replace it.

## Current verification (0.8.0 development)

- Failure retry backoff: 1s, 2s, capped at 60s; third failure becomes terminal. Persist only `EXTRACTION_FAILED`, not provider error text.
- Added concurrent turn-stop test: shared queue lease permits one model call; plugin teardown waits before closing SQLite.
- Latest full run with `DSH_SESSION_TEST_MODULE` pointing to the installed Host session package: **101/101 passed, zero skipped**. The extra test constructs a real detached Session, appends validated tool/call and tool/result events and checks reader scope. It does not modify the running profile or prove the complete live Cordis lifecycle. Parallel test runner previously stalled in cases CLI subprocess; serial full run passes.
- Version synchronization: package.json and seeded `assets/shared.sh` both `0.8.0`.
- Candidate retrieval exposed through `shared_cases.candidate_search`/`candidate_read`; local-only offline fixture: 7,121 full JSON chars vs 844 compact chars (88.1% lower), 10 candidates and source-ID drill-down. This is not tokenizer token or model-quality evidence.
- Synthetic retrieval fixture (8 queries): Recall@3=1.0, MRR=0.875; two similar package/runtime failures rank second. This measures retrieval only, not generated-answer quality.
- Independent source audit found and fixed two lifecycle bugs: the turn-stopping listener must resolve undefined so Cordis serial dispatch continues; an expired third-attempt lease now becomes failed/LEASE_EXPIRED. Full suite with installed Session contract: 102/102, zero skipped.
- Further source-audit findings still open: allowlist filtering before batch hydration; terminal-job retention/capacity; independent retry scheduling/startup recovery.
- Remaining: no live provider usage/token cost/latency or answer-quality measurement and no live installed-Host lifecycle run. Do not claim production readiness or that independently installed meow-memory reflection is replaced.
