# Recoverable Agent deletion

The Agent, messages and Runs are removed in the same `launchpad.json` mutation
that records their pending cleanup. The record contains only IDs, Run IDs and
the original and planned archive paths, rather than prompts or credentials.
Deleting a record does not restore the Agent when a filesystem operation fails.
Concurrent DELETEs reuse the intent inside the serialized mutation, so there
is one archive destination for the Agent.

A deletion gate is established before the first await. Start, edit and message
admission check it inside their store mutation as well as at relevant entry
points. Deletion waits for already admitted edits and message publication to
settle before cancelling and archiving. A Run committed before the gate but
not yet published to active executions is cancelled without starting its runner.
This prevents late instructions writes from recreating an archived workspace.

After that commit, all affected Runs are synchronously excluded from OTLP
scheduling and their current HTTP request is aborted. A checkpoint already
waiting to write cannot publish them back into the worker. A request accepted
by the collector before cancellation cannot be retracted.

Queue-file removal, span-file removal and workspace archiving are attempted
independently. An `EACCES`, `EPERM`, busy workspace or failed cleanup acknowledgment
leaves the cleanup record on disk. Archiving is still attempted when an unlink
fails. The record is removed only after all three steps and the final database
write succeed. The planned archive path stays fixed across retries, including a
restart after the directory was renamed but before cleanup was acknowledged.
An absent original workspace with no archive is also a completed cleanup; an
absent archive parent with an existing workspace remains pending.

`DELETE /api/agents/:id` returns `{ archivedWorkspace, cleanupPending }` after the
removal intent has committed. A pending deletion can be retried using the same
ID even though the Agent is already absent. After cleanup completes, that ID
returns 404 as before. Failure to commit the initial removal still returns an
error and preserves the Agent and its workspace for retry.

Cleanup is serialized, retried every five seconds while the server is running,
and attempted again before starting the exporter after a restart. Startup also
journals orphan trace files from older interrupted deletions. Their failed
unlink cannot block the HTTP service or make deleted Runs eligible for export.
`/api/system` reports only `deletionCleanup.pendingRecords` and `pendingRuns`;
warnings identify the failed cleanup steps without printing filesystem errors,
collector credentials or workspace contents. Shutdown clears the retry timer
and waits for any cleanup operation already running.

The journal inherits the main JSON store's atomic-rename and single-process
assumptions. Process restart recovery is covered; this is not a new power-loss
or multi-writer guarantee. Corrupt/unwritable main databases and inaccessible
storage directories can still prevent startup. Pending cleanup remains visible
until the underlying filesystem problem is fixed.

Regression coverage uses real JSON/span/outbox files, Fastify requests and a
loopback HTTP collector with injected file-specific permission errors. It
checks persisted deletion intent, archive progress despite unlink failures,
healthy delivery after restart without deleted-Run export, explicit and timed
retry, legacy orphan migration, and the rename-before-ack crash window.
Controlled concurrency regressions exercise queued and committed admissions,
Start/edit during cancellation, in-flight workspace edits and duplicate DELETEs. The
runner is prohibited from making model calls. Existing source-pinned OTLP
benchmarks remain historical measurements of their recorded source commits;
this deletion change does not claim new benchmark results.
