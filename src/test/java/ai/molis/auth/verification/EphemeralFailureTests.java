package ai.molis.auth.verification;

import ai.molis.auth.security.TokenSecrets;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class EphemeralFailureTests {
    @Test void redisOutageCannotBecomeValidProofOrUnlimitedRequests() {
        var redis = mock(StringRedisTemplate.class);
        when(redis.execute(any(org.springframework.data.redis.core.script.RedisScript.class), anyList(), any(Object[].class)))
                .thenThrow(new RedisConnectionFailureException("private command and secret args"));
        var proofs = new RedisMailboxProofs(redis);
        var limiter = new RedisRateLimiter(redis);
        assertUnavailable(() -> proofs.issue("person@example.test", RedisMailboxProofs.Purpose.REGISTER, TokenSecrets.generate()));
        assertUnavailable(() -> proofs.verifyLink(TokenSecrets.generate(), TokenSecrets.generate()));
        assertUnavailable(() -> proofs.consume(TokenSecrets.generate(), RedisMailboxProofs.Purpose.REGISTER, TokenSecrets.generate()));
        assertUnavailable(() -> limiter.acquire(RedisRateLimiter.Bucket.LOGIN_IP, "127.0.0.1"));
    }
    private static void assertUnavailable(org.assertj.core.api.ThrowableAssert.ThrowingCallable action) {
        assertThatThrownBy(action).isInstanceOfSatisfying(EphemeralFailure.class, failure -> {
            assertThat(failure.reason()).isEqualTo(EphemeralFailure.Reason.UNAVAILABLE);
            assertThat(failure.getCause()).isNull();
            assertThat(failure.toString()).doesNotContain("private command", "secret args");
        });
    }
}
