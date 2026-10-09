# Durable OTLP delivery

Finished Run spans are published locally, then placed in a file-backed outbox.
Only the local write is awaited; collector HTTP latency and retries happen in
one background worker. A collector outage does not turn a completed Run into a
failure. The existing trace endpoint continues to read the local SpanStore.

## Protocol outcomes

The exporter follows the [OTLP/HTTP response rules](https://opentelemetry.io/docs/specs/otlp/#otlphttp-response):

| Collector outcome | Exporter behavior |
| --- | --- |
| Success | Checkpoint this batch, then send the next batch. |
| HTTP 429, 502, 503, 504; connection failure or timeout | Retain the identical batch and retry with exponential backoff and random jitter. Honor Retry-After, capped at one day. |
| Populated partial success | Never resend that batch. Record the rejected span count and continue later batches. A zero-rejection warning records a warning without retrying. |
| Other 4xx/5xx | Never resend. Count the batch's spans as rejected, then continue later batches. |
| Oversized or malformed success response | Do not resend. Record acceptance as uncertain, since the receiver may have accepted the request. |

Full success expects HTTP 200; unexpected 201/204 success statuses are recorded
as uncertain without retry. Empty HTTP 200 bodies are tolerated for existing
collectors, alongside the specified JSON response. This is an explicit
compatibility allowance, not strict validation of every OTLP response field.

Response bodies are bounded after decompression (64 KiB by default, up to 4 MiB
through `OTEL_EXPORTER_OTLP_MAX_RESPONSE_BYTES`). Error response bodies and warning
text are not written to logs or the outbox. A single span exceeding the configured
request limit cannot be split; the collector may reject it, which remains visible
in the terminal loss counters rather than causing an infinite 413 retry loop.

`GET /api/system` reports pending and fully delivered Runs separately from partial,
rejected and uncertain outcomes; rejected/uncertain span and warning counts also
survive restart. These are collector acknowledgments, not proof that a downstream
storage system has committed the data.

## Persistence and crash semantics

The outbox writes a redacted, immutable payload and per-batch cursor to
`APP_DATA_DIR/otlp-outbox/<run-id>.json`, flushes the temporary file, and atomically
publishes it. On POSIX it also syncs the directory; Windows does not expose a
portable directory fsync, so sudden power-loss behavior depends on the filesystem.
The tests demonstrate process-crash recovery, not power-failure recovery.

Only one worker sends; concurrent enqueue calls for the same Run collapse into
one payload. Once settled, the entry becomes a small payload-free acknowledgment
with accepted/rejected/uncertain counts. This prevents normal restarts or repeated
enqueue calls from resending settled Runs. If checkpoint publication fails after
a response is received, the live process retries the disk write only, retaining
the known response without issuing another HTTP request.

A crash after collector acceptance but before checkpoint publication can still
cause an ambiguous batch to be replayed. Stable trace/span ids are preserved, but
OTLP does not guarantee receiver deduplication or exactly-once ingestion. Rejected
span identities are not returned in partial success, so the exporter cannot retry
only the rejected subset. The locally retained full trace is the diagnostic source.

Startup reconciles final local spans missing an outbox entry, recovering the
window between SpanStore publication and enqueue. On first upgrade, existing
terminal traces are backfilled once; previously exported traces may therefore
appear again at receivers without deduplication. Unreadable queue entries are
preserved with a `.corrupt.*` suffix and recovered from local final spans, which
also makes their prior remote acceptance uncertain. Queue disk failures are logged;
local spans remain available and startup retries reconciliation. Disk exhaustion
cannot be advertised as guaranteed remote delivery.

Queued data is pinned to the original collector URL; changing the URL pauses those
entries instead of forwarding historical content to a different destination.
Restore the original URL to resume. Header credentials are read from current
configuration and never stored in entries. Authentication changes therefore affect
pending sends, while a terminal 401 remains a terminal rejection under the protocol.
Deleted Agents purge their queue entries and acknowledgment metadata. A request
already received remotely cannot be recalled. One process must own each data
directory; shared multi-process outbox ownership is unsupported.

Pending payloads and acknowledgment records have no automatic retention limit;
an extended outage needs disk monitoring. The status endpoint exposes oldest
pending age. Deleting an Agent removes its entries; deleting arbitrary queue
files while keeping Runs can cause startup backfill and duplicate ingestion.

## Verification and performance

Run `npm run check` for unit tests, production build, replay HTTP checks, and
`smoke:otlp`. The latter starts real built server processes and a loopback HTTP
collector, forces SIGKILL after 503 and timeout faults, starts new processes on
the same data directory, and checks byte-identical replay plus no resend of an
acknowledged Run. Unit tests additionally cover partial success, warning replies,
nonretryable HTTP codes, batching, header redaction, checkpoint disk failure,
destination changes, shutdown, deletion and the SpanStore-to-outbox recovery gap.

Run `npm run benchmark:otlp` to record the comparison in
`docs/evidence/otlp-benchmark.json`. It uses four order-balanced replay blocks,
two excluded warmups per block, and 40 measured Runs per arm by default. A separate
alternating-order microbenchmark compares a 100-span file write with the same
write plus a flushed outbox publication. Measurements are host-specific; the
replay path uses no model, and differences do not establish an application-wide
speedup or a cloud latency claim.

Measured on 2026-10-09 with Node 24.18.0, Windows 10.0.26200 and an Intel i5-14500,
at feature source `6fd559ca7207aaec902935fb27984baf4576905b`:

| Measurement | Baseline p95 | Durable outbox p95 | Samples per arm |
| --- | --- | --- | --- |
| Replay HTTP Run completion; durable arm's collector always returns 503 | 218.116 ms | 201.731 ms | 40 |
| Local persistence of 100 spans | 3.546 ms | 12.343 ms | 40 |

All 40 measured durable-arm Runs completed. Including excluded warmups, 44
pending Runs remained on disk during the 503 outage. The local persistence
comparison shows the added flush/publication cost; the lower replay p95 is host
variation, not evidence that exporting improves execution. The
[raw benchmark](evidence/otlp-benchmark.json) records normalized source hashes and
methodology. [Forced-process recovery evidence](evidence/otlp-recovery.json)
records byte-identical replay after 503/timeout and no resend after confirmation.
