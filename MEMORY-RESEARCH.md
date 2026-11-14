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
