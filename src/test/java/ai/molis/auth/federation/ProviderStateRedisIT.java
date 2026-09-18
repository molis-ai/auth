package ai.molis.auth.federation;

import ai.molis.auth.security.TokenSecrets;
import java.net.URI;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.*;
import org.springframework.data.redis.core.StringRedisTemplate;
import static org.assertj.core.api.Assertions.*;
import static ai.molis.auth.federation.ProviderStateTests.*;

/** Two independent Redis connections; unique per-test keys, no global flush or production defaults. */
class ProviderStateRedisIT {
    private static LettuceConnectionFactory first, second;
    private StringRedisTemplate redis;
    private RedisProviderTransactions one, two;
    private String prefix;
    private String browser;
    private final ProviderRegistration google = new ProviderRegistration(IdentityProvider.GOOGLE, "test-client", URI.create("https://auth.example.test/callback/google"));
    private final ProviderRegistration apple = new ProviderRegistration(IdentityProvider.APPLE, "test-client", URI.create("https://auth.example.test/callback/apple"));
    private final Set<String> keys = new HashSet<>();

    @BeforeAll static void connect() { first = connection(); second = connection(); }
    @AfterAll static void close() { if (first != null) first.destroy(); if (second != null) second.destroy(); }
    private static LettuceConnectionFactory connection() {
        int port = Integer.parseInt(System.getProperty("auth.it.redis-port", "0"));
        if (port < 1024 || port > 65535 || port == 6379) throw new IllegalArgumentException("Dedicated loopback Redis port required");
        var client = LettuceClientConfiguration.builder().commandTimeout(Duration.ofSeconds(1)).shutdownTimeout(Duration.ofMillis(100)).build();
        var factory = new LettuceConnectionFactory(new RedisStandaloneConfiguration("127.0.0.1", port), client);
        factory.afterPropertiesSet(); factory.start(); return factory;
    }
    @BeforeEach void setup() {
        prefix = "auth_test:provider:" + UUID.randomUUID() + ":"; browser = TokenSecrets.generate();
        redis = new StringRedisTemplate(first);
        one = new RedisProviderTransactions(redis, cipher(), Clock.systemUTC(), prefix);
        two = new RedisProviderTransactions(new StringRedisTemplate(second), cipher(), Clock.systemUTC(), prefix);
    }
    @AfterEach void cleanup() { if (!keys.isEmpty()) redis.delete(keys); }
    private RedisProviderTransactions.Issued issue(ProviderRegistration registration) {
        var result = one.create(registration, TokenSecrets.generate(), UUID.randomUUID().toString(), browser);
        keys.add(one.key(result.state())); return result;
    }

    @Test void independentNodeConsumesOnceWithoutPlaintextSecretsInRedis() {
        var issued = issue(google); var pending = issued.pending();
        var stored = redis.opsForHash().entries(one.key(issued.state()));
        assertThat(stored).hasSize(2);
        assertThat(stored.toString()).doesNotContain(browser, issued.state(), pending.authTransaction(), pending.nonce(), pending.verifier(), pending.claimOwner());
        assertThat(one.key(issued.state())).doesNotContain(issued.state());
        assertThat(redis.getExpire(one.key(issued.state()), TimeUnit.MILLISECONDS)).isBetween(1L, 300000L);
        assertThat(two.consume(issued.state(), google, browser)).isEqualTo(pending);
        rejected(() -> one.consume(issued.state(), google, browser));
        assertThat(issued.toString() + pending).doesNotContain(issued.state(), pending.authTransaction(), pending.verifier());
    }

    @Test void browserProviderClientAndCallbackMustMatchWithoutConsumingOrExtendingTtl() {
        var issued = issue(google); String key = one.key(issued.state());
        long before = redis.getExpire(key, TimeUnit.MILLISECONDS);
        rejected(() -> two.consume(issued.state(), google, TokenSecrets.generate()));
        rejected(() -> two.consume(issued.state(), apple, browser));
        rejected(() -> two.consume(issued.state(), new ProviderRegistration(IdentityProvider.GOOGLE, "other-client", google.callback()), browser));
        rejected(() -> two.consume(issued.state(), new ProviderRegistration(IdentityProvider.GOOGLE, google.clientId(), URI.create("https://auth.example.test/other")), browser));
        assertThat(redis.getExpire(key, TimeUnit.MILLISECONDS)).isPositive().isLessThanOrEqualTo(before);
        assertThat(two.consume(issued.state(), google, browser)).isEqualTo(issued.pending());
    }

    @RepeatedTest(3) void competingNodesGetExactlyOneClaim() throws Exception {
        var issued = issue(google); var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var a = executor.submit(() -> consumeAfter(one, issued.state(), start));
            var b = executor.submit(() -> consumeAfter(two, issued.state(), start));
            start.countDown();
            assertThat(List.of(a.get(5, TimeUnit.SECONDS), b.get(5, TimeUnit.SECONDS))).containsExactlyInAnyOrder(true, false);
        }
    }
    private boolean consumeAfter(RedisProviderTransactions store, String state, CountDownLatch start) throws Exception {
        start.await();
        try { store.consume(state, google, browser); return true; }
        catch (ExternalFailure invalid) { assertThat(invalid).hasMessage("PROVIDER_TRANSACTION_INVALID"); return false; }
    }

    @Test void expiredMissingOrExcessiveTtlFailsClosed() {
        for (int mode = 0; mode < 3; mode++) {
            var issued = issue(google); String key = one.key(issued.state());
            if (mode == 0) redis.expire(key, Duration.ZERO);
            if (mode == 1) redis.persist(key);
            if (mode == 2) redis.expire(key, Duration.ofMinutes(6));
            rejected(() -> two.consume(issued.state(), google, browser));
            assertThat(redis.hasKey(key)).isFalse();
        }
    }

    @Test void ciphertextCannotBeTransplantedAndBadPayloadCannotBeRetried() {
        var a = issue(google); var b = issue(google);
        Object payload = redis.opsForHash().get(one.key(a.state()), "payload");
        redis.opsForHash().put(one.key(b.state()), "payload", payload);
        rejected(() -> two.consume(b.state(), google, browser));
        assertThat(redis.hasKey(one.key(b.state()))).isFalse();
        assertThat(two.consume(a.state(), google, browser)).isEqualTo(a.pending());
        var c = issue(google);
        redis.opsForHash().put(one.key(c.state()), "payload", "invalid-protected-data");
        rejected(() -> two.consume(c.state(), google, browser));
        assertThat(redis.hasKey(one.key(c.state()))).isFalse();
    }

    @Test void keyRotationWorksAcrossNodesAndRemovedKeysFailClosed() {
        var a = issue(google);
        var rotated = new ProviderStateCipher("new", Map.of("test", testKey(1), "new", testKey(2)));
        var reader = new RedisProviderTransactions(new StringRedisTemplate(second), rotated, Clock.systemUTC(), prefix);
        assertThat(reader.consume(a.state(), google, browser)).isEqualTo(a.pending());
        var b = issue(google);
        var removed = new RedisProviderTransactions(redis, new ProviderStateCipher("new", Map.of("new", testKey(2))), Clock.systemUTC(), prefix);
        rejected(() -> removed.consume(b.state(), google, browser));
        rejected(() -> one.consume(b.state(), google, browser));
    }

    @Test void encryptedStartTimeCapsLifetimeEvenWhenRedisTtlLooksValid() {
        var issued = issue(google);
        var future = new RedisProviderTransactions(redis, cipher(), Clock.offset(Clock.systemUTC(), Duration.ofSeconds(300)), prefix);
        rejected(() -> future.consume(issued.state(), google, browser));
        var another = issue(google);
        var past = new RedisProviderTransactions(redis, cipher(), Clock.offset(Clock.systemUTC(), Duration.ofSeconds(-120)), prefix);
        rejected(() -> past.consume(another.state(), google, browser));
    }

    @Test void appleHasIndependentNonceButNoInventedPkce() {
        var issued = issue(apple);
        assertThat(issued.pending().nonce()).matches("[A-Za-z0-9_-]{43}").isNotEqualTo(issued.state()).isNotEqualTo(browser);
        assertThat(issued.pending().verifier()).isNull();
        assertThat(two.consume(issued.state(), apple, browser)).isEqualTo(issued.pending());
    }
}
