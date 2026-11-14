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

`CaseStore.observe` now records allowlisted outcome metadata at tools/result: failed/returned/unknown, session/call/workspace/tool and bounded symbolic error codes. It does not inspect arguments, value or content. Captures of memory_* and shared_cases are excluded. Duplicate session/call pairs are ignored. Capture stops at 10,000 observations rather than growing indefinitely. `automaticCapture:false` disables new observation capture; the existing failure incident feature remains separate. There is no background inference, turn-end prompt, automatic injection or verified-case promotion in this slice.

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
