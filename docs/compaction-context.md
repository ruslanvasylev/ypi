# Compaction file history

Pi owns summarization, recent-message retention and the persisted compaction
checkpoint. ypi reduces one repeated part of the model context: Pi's cumulative
list of files read and modified. A large inventory becomes a short reference to
the exact compaction entry and its `details.readFiles` and
`details.modifiedFiles` fields in the session JSONL.

The `context` extension hook changes only the messages sent to the model. The
summary narrative, goals, constraints, unresolved work, recent messages, stored
summary and complete file inventory remain unchanged. Pi continues to receive
the complete previous checkpoint when generating its next summary. The pointer
identifies a specific entry so it remains usable after further compactions.

Projection requires an active `bash` tool, a readable regular session file and
one matching compaction entry on the active branch. Toolsets without `bash`
retain the complete inventory because Pi's line-based `read` tool cannot select
fields near the end of a large JSONL record. The summary, timestamp and pre-compaction token count must
match, the file lists must contain strings, and the generated appendix must
match the entire trailing text exactly. Unknown formats, extension-generated
summaries, missing files, ambiguous matches and inventories smaller than the
reference are passed through unchanged. Resuming or switching branches uses
the current session and branch; there is no cached cross-session state.

This reduces repeated file-list transmission without an additional model call.
It does not bound generated prose, replace Pi's compaction policy or guarantee
lower uncached-token billing. The model can retrieve an earlier exact path by
selecting the referenced JSONL entry's file-list fields and filtering them.

Run `make test-compaction-context` for deterministic projection, preservation,
resume and branch-isolation checks. It is included in `make test-fast`.
