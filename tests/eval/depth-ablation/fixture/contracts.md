# Runtime utility contracts

Review only correctness, security, and resource-lifecycle violations of these contracts.

1. Token claims use Unix epoch **seconds**. `isFresh` returns true only when expiry is strictly later than the current instant plus the requested skew.
2. Pagination advances exclusively with the service's opaque `nextCursor`. A page may be empty while `hasMore=true`; the collector must either advance or reject a non-progressing cursor.
3. Cache entries may contain any JavaScript value, including `0`, `false`, and `""`. Failed loads are never cached, and failed in-flight entries must be evicted so a later call can retry.
4. `maxAttempts` is the total number of attempts, not the retry count. Automatic retry is allowed only for GET and PUT. HTTP `Retry-After` integer values are seconds.
5. A candidate filesystem path is allowed only when its real path is the root itself or a descendant separated by a path boundary. Symlinks escaping the root are forbidden.
6. A timeout wrapper must clear its timer when work settles and must abort the underlying operation when the deadline wins.
