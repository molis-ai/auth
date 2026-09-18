package ai.molis.auth.session;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class SessionLifetimeTests {
    private static final Instant START = Instant.parse("2026-01-01T00:00:00Z");

    @Test
    void idleExpiresAtThirtyDaysExactly() {
        var lifetime = new SessionLifetime(START, START);
        assertThat(lifetime.isActiveAt(START.plus(Duration.ofDays(30)).minusNanos(1))).isTrue();
        assertThat(lifetime.isActiveAt(START.plus(Duration.ofDays(30)))).isFalse();
        assertThatIllegalStateException().isThrownBy(
                () -> lifetime.recordUserActivity(START.plus(Duration.ofDays(30))));
    }

    @Test
    void activeUseStillCannotExtendAbsoluteLimit() {
        var lifetime = new SessionLifetime(START, START);
        for (int day = 1; day < 90; day++) {
            lifetime = lifetime.recordUserActivity(START.plus(Duration.ofDays(day)));
        }
        assertThat(lifetime.expiresAt()).isEqualTo(START.plus(Duration.ofDays(90)));
        assertThat(lifetime.isActiveAt(START.plus(Duration.ofDays(90)))).isFalse();
        assertThat(lifetime.authenticatedAt()).isEqualTo(START);
    }

    @Test
    void repeatedTokenIssuanceDoesNotExtendIdleAndClampsExpiry() {
        var lifetime = new SessionLifetime(START, START);
        Instant nearExpiry = START.plus(Duration.ofDays(30)).minusSeconds(60);
        assertThat(lifetime.tokenExpiresAt(nearExpiry, Duration.ofMinutes(15)))
                .isEqualTo(START.plus(Duration.ofDays(30)));
        assertThat(lifetime.lastUserActivityAt()).isEqualTo(START);
        assertThatIllegalStateException().isThrownBy(() ->
                lifetime.tokenExpiresAt(START.plus(Duration.ofDays(30)), Duration.ofMinutes(15)));
    }

    @Test
    void oldConcurrentActivityDoesNotMoveLastActivityBackwards() {
        var lifetime = new SessionLifetime(START, START.plusSeconds(200));
        assertThat(lifetime.recordUserActivity(START.plusSeconds(100)).lastUserActivityAt())
                .isEqualTo(START.plusSeconds(200));
    }

    @Test
    void invalidTimesAndTtlsFailClosed() {
        assertThatIllegalArgumentException().isThrownBy(() -> new SessionLifetime(START, START.minusSeconds(1)));
        var lifetime = new SessionLifetime(START, START);
        assertThat(lifetime.isActiveAt(START.minusNanos(1))).isFalse();
        assertThatIllegalArgumentException().isThrownBy(() -> lifetime.tokenExpiresAt(START, Duration.ZERO));
    }
}
