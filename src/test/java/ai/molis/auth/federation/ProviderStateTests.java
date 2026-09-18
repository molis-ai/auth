package ai.molis.auth.federation;

import java.net.URI;
import java.time.Clock;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class ProviderStateTests {
    static String testKey(int value) { byte[] key = new byte[32]; Arrays.fill(key, (byte) value); return Base64.getEncoder().encodeToString(key); }
    static ProviderStateCipher cipher() { return new ProviderStateCipher("test", Map.of("test", testKey(1))); }

    @Test void randomizedEncryptionAuthenticatesPayloadContextAndKey() {
        var cipher = cipher(); String secret = "temporary-auth-secret";
        String first = cipher.seal(secret, "first"); String second = cipher.seal(secret, "first");
        assertThat(first).isNotEqualTo(second).doesNotContain(secret);
        assertThat(cipher.open(first, "first")).isEqualTo(secret);
        rejected(() -> cipher.open(first, "second"));
        rejected(() -> new ProviderStateCipher("test", Map.of("test", testKey(2))).open(first, "first"));
        String[] parts = first.split("\\.");
        byte[] encrypted = Base64.getUrlDecoder().decode(parts[3]); encrypted[0] ^= 1;
        rejected(() -> cipher.open(parts[0] + "." + parts[1] + "." + parts[2] + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(encrypted), "first"));
    }

    @Test void rotationKeepsOldReadsOnlyWhileOldKeyIsRetained() {
        String old = cipher().seal("secret", "context");
        var rotated = new ProviderStateCipher("new", Map.of("test", testKey(1), "new", testKey(2)));
        assertThat(rotated.open(old, "context")).isEqualTo("secret");
        assertThat(rotated.seal("secret", "context")).startsWith("v1.new.");
        rejected(() -> new ProviderStateCipher("new", Map.of("new", testKey(2))).open(old, "context"));
    }

    @Test void malformedConfigurationAndEnvelopesAreSafe() {
        for (var keys : List.of(Map.<String,String>of(), Map.of("test", "not-a-key"), Map.of("bad.id", testKey(1))))
            assertThatThrownBy(() -> new ProviderStateCipher("test", keys)).hasMessage("Invalid provider state key configuration").hasNoCause();
        for (String envelope : List.of("", "v2.test.a.b", "v1.test.a.b", "v1.unknown.a.b", "x".repeat(8193)))
            rejected(() -> cipher().open(envelope, "context"));
        assertThatThrownBy(() -> cipher().seal("x".repeat(4097), "context")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void invalidInputsDoNotReachRedisAndOutageDoesNotBecomeAuthentication() {
        var redis = mock(StringRedisTemplate.class);
        var store = new RedisProviderTransactions(redis, cipher(), Clock.systemUTC());
        var registration = new ProviderRegistration(IdentityProvider.GOOGLE, "client", URI.create("https://auth.example.test/callback/google"));
        rejected(() -> store.create(registration, "bad", UUID.randomUUID().toString(), "b".repeat(43)));
        rejected(() -> store.create(registration, "a".repeat(43), "bad", "b".repeat(43)));
        rejected(() -> store.consume("s".repeat(43), registration, "bad"));
        verifyNoInteractions(redis);
        doThrow(new DataAccessResourceFailureException("redis://secret@private-host")).when(redis).execute(any(), anyList(), any(Object[].class));
        assertThatThrownBy(() -> store.consume("s".repeat(43), registration, "b".repeat(43)))
                .isInstanceOf(ExternalFailure.class).hasMessage("AUTH_UNAVAILABLE").hasNoCause();
    }

    static void rejected(org.assertj.core.api.ThrowableAssert.ThrowingCallable action) {
        assertThatThrownBy(action).isInstanceOf(ExternalFailure.class).hasMessage("PROVIDER_TRANSACTION_INVALID").hasNoCause();
    }
}
