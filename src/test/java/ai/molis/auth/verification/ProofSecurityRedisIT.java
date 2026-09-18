package ai.molis.auth.verification;

import ai.molis.auth.security.TokenSecrets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.*;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import static ai.molis.auth.verification.RedisMailboxProofs.Purpose.*;
import static ai.molis.auth.verification.EphemeralFailure.Reason.*;
import static org.assertj.core.api.Assertions.*;

/** Real Redis Lua execution over two independent connections; no FLUSHDB/FLUSHALL or global keys. */
class ProofSecurityRedisIT {
    private static LettuceConnectionFactory first, second;
    private StringRedisTemplate redis;
    private RedisMailboxProofs one, two;
    private RedisRateLimiter limitOne, limitTwo;
    private String prefix;

    @BeforeAll static void connect() { first = RedisTestConnections.open(); second = RedisTestConnections.open(); }
    @AfterAll static void close() { if (first != null) first.destroy(); if (second != null) second.destroy(); }
    @BeforeEach void setup() {
        prefix = "auth_test:" + UUID.randomUUID() + ":";
        redis = new StringRedisTemplate(first);
        var another = new StringRedisTemplate(second);
        one = new RedisMailboxProofs(redis, prefix, Duration.ofMinutes(10));
        two = new RedisMailboxProofs(another, prefix, Duration.ofMinutes(10));
        limitOne = new RedisRateLimiter(redis, prefix);
        limitTwo = new RedisRateLimiter(another, prefix);
    }

    @Test void storesOnlySecretsDigestsAndConsumesVerifiedProofOnce() {
        String binding = TokenSecrets.generate();
        var issued = one.issue(" Alice+test@EXAMPLE.TEST ", REGISTER, binding);
        var stored = redis.opsForHash().entries(one.key(issued.challenge()));
        assertThat(stored.values()).doesNotContain(binding, issued.deliverySecret(), issued.challenge());
        assertThat(stored.get("email")).isEqualTo("alice+test@example.test");
        rejects(INVALID_PROOF, () -> two.consume(issued.challenge(), REGISTER, binding));
        two.verifyLink(issued.challenge(), issued.deliverySecret());
        assertThat(redis.opsForHash().hasKey(one.key(issued.challenge()), "secret")).isFalse();
        var proof = one.consume(issued.challenge(), REGISTER, binding);
        assertThat(proof.email()).isEqualTo("alice+test@example.test");
        assertThat(proof.purpose()).isEqualTo(REGISTER);
        assertThat(proof.operationId()).matches("[0-9a-f-]{36}");
        assertThat(proof.toString()).doesNotContain(proof.email());
        assertThat(issued.toString()).doesNotContain(issued.challenge(), issued.deliverySecret());
        rejects(INVALID_PROOF, () -> two.consume(issued.challenge(), REGISTER, binding));
    }

    @Test void purposeAndOriginatingTransactionCannotBeSubstituted() {
        String binding = TokenSecrets.generate();
        var issued = one.issue("user@example.test", REGISTER, binding);
        one.verifyLink(issued.challenge(), issued.deliverySecret());
        rejects(INVALID_PROOF, () -> two.consume(issued.challenge(), PASSWORD_RESET, binding));
        rejects(INVALID_PROOF, () -> two.consume(issued.challenge(), REGISTER, TokenSecrets.generate()));
        assertThat(one.consume(issued.challenge(), REGISTER, binding).purpose()).isEqualTo(REGISTER);
    }

    @Test void fiveWrongLinksInvalidateChallengeAndCorrectLinkCannotReviveIt() {
        String binding = TokenSecrets.generate();
        var issued = one.issue("user@example.test", REGISTER, binding);
        for (int attempt = 0; attempt < 5; attempt++)
            rejects(INVALID_PROOF, () -> two.verifyLink(issued.challenge(), TokenSecrets.generate()));
        assertThat(redis.hasKey(one.key(issued.challenge()))).isFalse();
        rejects(INVALID_PROOF, () -> one.verifyLink(issued.challenge(), issued.deliverySecret()));
    }

    @Test void verificationDoesNotExtendExpirationAndExpiredProofCannotBeUsed() {
        String binding = TokenSecrets.generate();
        var issued = one.issue("user@example.test", REGISTER, binding);
        redis.expire(one.key(issued.challenge()), Duration.ofSeconds(3));
        long before = redis.getExpire(one.key(issued.challenge()), TimeUnit.MILLISECONDS);
        one.verifyLink(issued.challenge(), issued.deliverySecret());
        long after = redis.getExpire(one.key(issued.challenge()), TimeUnit.MILLISECONDS);
        assertThat(after).isPositive().isLessThanOrEqualTo(before);
        redis.expire(one.key(issued.challenge()), Duration.ZERO);
        rejects(INVALID_PROOF, () -> two.consume(issued.challenge(), REGISTER, binding));
    }

    @Test void proofWithoutTtlFailsClosed() {
        String binding = TokenSecrets.generate();
        var issued = one.issue("user@example.test", REGISTER, binding);
        redis.persist(one.key(issued.challenge()));
        try { rejects(INVALID_PROOF, () -> two.verifyLink(issued.challenge(), issued.deliverySecret())); }
        finally { redis.delete(one.key(issued.challenge())); }
    }

    @RepeatedTest(3) void competingConsumersAcrossNodesGetExactlyOneProof() throws Exception {
        String binding = TokenSecrets.generate();
        var issued = one.issue("user@example.test", PASSWORD_RESET, binding);
        one.verifyLink(issued.challenge(), issued.deliverySecret());
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var a = executor.submit(() -> { start.await(); return consume(one, issued.challenge(), binding); });
            var b = executor.submit(() -> { start.await(); return consume(two, issued.challenge(), binding); });
            start.countDown();
            assertThat(List.of(a.get(5, TimeUnit.SECONDS), b.get(5, TimeUnit.SECONDS))).containsExactlyInAnyOrder(true, false);
        }
    }

    @Test void repeatedVerificationDoesNotCreateSecondConsumableProof() {
        String binding = TokenSecrets.generate();
        var issued = one.issue("user@example.test", REGISTER, binding);
        one.verifyLink(issued.challenge(), issued.deliverySecret());
        rejects(INVALID_PROOF, () -> two.verifyLink(issued.challenge(), issued.deliverySecret()));
        one.consume(issued.challenge(), REGISTER, binding);
        rejects(INVALID_PROOF, () -> two.verifyLink(issued.challenge(), issued.deliverySecret()));
    }

    @Test void concurrentRateLimitIsSharedAndRejectsDoNotExtendWindow() throws Exception {
        String subject = "person@example.test";
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var futures = new ArrayList<java.util.concurrent.Future<Boolean>>();
            for (int i = 0; i < 30; i++) {
                var limiter = i % 2 == 0 ? limitOne : limitTwo;
                futures.add(executor.submit(() -> {
                    start.await();
                    try { limiter.acquire("test", subject, 7, 30_000); return true; }
                    catch (EphemeralFailure failure) { assertThat(failure.reason()).isEqualTo(RATE_LIMITED); return false; }
                }));
            }
            start.countDown();
            int allowed = 0;
            for (var future : futures) if (future.get(5, TimeUnit.SECONDS)) allowed++;
            assertThat(allowed).isEqualTo(7);
        }
        String key = limitOne.key("test", subject);
        assertThat(key).doesNotContain(subject);
        long before = redis.getExpire(key, TimeUnit.MILLISECONDS);
        rejects(RATE_LIMITED, () -> limitTwo.acquire("test", subject, 7, 30_000));
        assertThat(redis.getExpire(key, TimeUnit.MILLISECONDS)).isLessThanOrEqualTo(before);
    }

    @Test void expiredLimitResetsAndCorruptImmortalCounterFailsClosed() {
        limitOne.acquire("test", "subject", 1, 30_000);
        String key = limitOne.key("test", "subject");
        rejects(RATE_LIMITED, () -> limitTwo.acquire("test", "subject", 1, 30_000));
        redis.expire(key, Duration.ZERO);
        limitTwo.acquire("test", "subject", 1, 30_000);
        redis.persist(key);
        try { rejects(UNAVAILABLE, () -> limitOne.acquire("test", "subject", 1, 30_000)); }
        finally { redis.delete(key); }
    }

    @Test void malformedOrNegativeCountersDoNotBypassRateLimit() {
        String key = limitOne.key("test", "subject");
        try {
            for (String value : List.of("-10", "0.5", "not-a-counter")) {
                redis.opsForValue().set(key, value, Duration.ofSeconds(5));
                rejects(UNAVAILABLE, () -> limitTwo.acquire("test", "subject", 1, 30_000));
            }
        } finally { redis.delete(key); }
    }

    private static boolean consume(RedisMailboxProofs store, String challenge, String binding) {
        try { store.consume(challenge, PASSWORD_RESET, binding); return true; }
        catch (EphemeralFailure failure) { assertThat(failure.reason()).isEqualTo(INVALID_PROOF); return false; }
    }
    static void rejects(EphemeralFailure.Reason reason, org.assertj.core.api.ThrowableAssert.ThrowingCallable action) {
        assertThatThrownBy(action).isInstanceOfSatisfying(EphemeralFailure.class, failure -> assertThat(failure.reason()).isEqualTo(reason));
    }
}
