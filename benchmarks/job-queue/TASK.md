Repair this dependency-free job queue so it meets the contract below. The current
implementation has interacting bugs across queue.ts, retry.ts, and snapshot.ts.
Read the existing code, preserve the exported API, and add regression tests.

1. enqueue(input, now) accepts a unique string id containing at least one non-whitespace
   character (reject empty or whitespace-only ids; preserve accepted ids exactly), JSON payload, integer priority
   (default 0), and positive integer maxAttempts (default 3). now must be a finite
   nonnegative number. Reject invalid input and duplicate ids without changing state.
2. Jobs start queued, with attempts=0 and availableAt=now. Inputs and returned jobs
   must be deep copies: callers cannot mutate queue state through payloads or snapshots.
3. claim(now, leaseMs) requires positive finite leaseMs. First recover expired leases,
   then claim an eligible queued job (availableAt <= now), highest priority first,
   FIFO for equal priorities. Increment attempts exactly once, set status=running
   and leaseUntil=now+leaseMs. Return null if nothing is eligible.
4. complete(id) and fail(id, error, now) require a running job. Unknown ids and invalid
   transitions throw without changing state. Completion clears its lease and marks
   it succeeded. Failure records error, clears its lease, and either marks it failed
   when attempts >= maxAttempts or queues it for retry at now+retryDelay(...).
5. retryDelay(attempt, base, cap) is min(cap, base * 2^(attempt-1)). All three arguments
   must be positive finite numbers; attempt must be an integer. Large attempts must
   saturate at cap only when the mathematical delay reaches cap. All positive finite
   base values, including subnormal numbers, are supported: an overflowing intermediate
   power of two must not force the result to cap when the scaled delay is still below it.
   The queue's defaults are baseDelayMs=100 and
   maxDelayMs=10000; constructor options must obey the same positive-finite rules.
6. recoverExpired(now) recovers running jobs whose leaseUntil <= now. Preserve attempts.
   Queue them immediately at now when attempts remain; otherwise mark them failed.
   Clear leases and set lastError="Lease expired". Leave other jobs unchanged.
7. cancel(id) cancels queued or running jobs and clears their leases. Terminal jobs
   (succeeded, failed, cancelled) remain unchanged. Cancelled jobs cannot be claimed.
8. get(id) returns a deep copy or undefined; list() returns deep copies in insertion order.
9. snapshot() returns { version:1, options, jobs, nextSequence }, with deep copies.
   JobQueue.restore(snapshot, now) validates the entire snapshot before restoring:
   version, options, unique string ids with at least one non-whitespace character and
   unique sequences, nextSequence beyond all sequences,
   JSON payloads, integer priorities, nonnegative finite timestamps, positive maxAttempts,
   attempts in [0,maxAttempts], valid statuses, and lease/status consistency.
   Running jobs must have attempts>=1 and a nonnegative finite leaseUntil; all other
   statuses must have leaseUntil=null. Succeeded/failed jobs need attempts>=1;
   failed jobs must have exhausted maxAttempts. Queued jobs need attempts<maxAttempts.
   lastError must be string or null. Reject malformed snapshots without mutating them.
10. Restore cannot resume an old process's in-flight work. Convert ALL restored running
    jobs (including unexpired leases) to queued at now if attempts remain, otherwise
    failed, clearing leases and recording lastError="Interrupted by restore".
    Preserve terminal jobs, retry schedules of already queued jobs, options, insertion
    order, and attempts. Subsequent enqueues must receive fresh monotonic sequences.

Use Bun and TypeScript. Change only src/ and tests/. Do not weaken or remove existing
tests. This scratch directory is not a Git repository. Run bun test; report changes,
verification, and remaining limitations. A separate grader will check edge cases.
