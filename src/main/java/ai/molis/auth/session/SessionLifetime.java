package ai.molis.auth.session;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

/**
 * Pure lifetime policy shared by browser authentication and application grants.
 * authenticatedAt is the original full-authentication time, never a refresh/recovery time.
 */
public record SessionLifetime(Instant authenticatedAt, Instant lastUserActivityAt) {
    public static final Duration IDLE_LIMIT = Duration.ofDays(30);
    public static final Duration ABSOLUTE_LIMIT = Duration.ofDays(90);

    public SessionLifetime {
        Objects.requireNonNull(authenticatedAt, "authenticatedAt");
        Objects.requireNonNull(lastUserActivityAt, "lastUserActivityAt");
        if (lastUserActivityAt.isBefore(authenticatedAt)) {
            throw new IllegalArgumentException("Activity precedes authentication");
        }
    }

    public Instant expiresAt() {
        Instant idleExpiry = lastUserActivityAt.plus(IDLE_LIMIT);
        Instant absoluteExpiry = authenticatedAt.plus(ABSOLUTE_LIMIT);
        return idleExpiry.isBefore(absoluteExpiry) ? idleExpiry : absoluteExpiry;
    }

    public boolean isActiveAt(Instant now) {
        Objects.requireNonNull(now, "now");
        return !now.isBefore(authenticatedAt) && now.isBefore(expiresAt());
    }

    /** Call only after a trusted user interaction; never for a background refresh. */
    public SessionLifetime recordUserActivity(Instant now) {
        if (!isActiveAt(now)) throw new IllegalStateException("Expired session cannot be revived");
        // Concurrent requests must persist max(previous, observed), under row lock/CAS.
        return new SessionLifetime(authenticatedAt, now.isAfter(lastUserActivityAt) ? now : lastUserActivityAt);
    }

    /** Issued credentials cannot outlive the underlying authentication session. */
    public Instant tokenExpiresAt(Instant now, Duration tokenTtl) {
        if (!isActiveAt(now)) throw new IllegalStateException("Inactive session cannot issue tokens");
        if (tokenTtl == null || tokenTtl.isNegative() || tokenTtl.isZero()) {
            throw new IllegalArgumentException("Token TTL must be positive");
        }
        Instant requested = now.plus(tokenTtl);
        return requested.isBefore(expiresAt()) ? requested : expiresAt();
    }
}
