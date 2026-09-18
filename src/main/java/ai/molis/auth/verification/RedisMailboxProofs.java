package ai.molis.auth.verification;

import ai.molis.auth.account.EmailAddress;
import ai.molis.auth.security.TokenSecrets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;
import static ai.molis.auth.verification.EphemeralFailure.Reason.*;

/** Internal primitive: validated auth-transaction creation and mail delivery precede public use. */
@Component
@ConditionalOnProperty(name = "auth.ephemeral.enabled", havingValue = "true")
public class RedisMailboxProofs {
    private static final DefaultRedisScript<Long> ISSUE = script("mailbox-issue.lua", Long.class);
    private static final DefaultRedisScript<Long> VERIFY = script("mailbox-verify.lua", Long.class);
    private static final DefaultRedisScript<List> CONSUME = script("mailbox-consume.lua", List.class);
    private final StringRedisTemplate redis;
    private final String prefix;
    private final Duration ttl;

    @org.springframework.beans.factory.annotation.Autowired
    public RedisMailboxProofs(StringRedisTemplate redis) { this(redis, "auth:v1:", Duration.ofMinutes(10)); }
    RedisMailboxProofs(StringRedisTemplate redis, String prefix, Duration ttl) {
        if (!prefix.matches("[A-Za-z0-9:_-]{1,100}") || ttl.toMillis() < 1 || ttl.compareTo(Duration.ofMinutes(10)) > 0)
            throw new IllegalArgumentException("Invalid proof store configuration");
        this.redis = redis; this.prefix = prefix; this.ttl = ttl;
    }

    /** Delivery secret goes ONLY to protected email delivery, never in the initiating API response. */
    public Issued issue(String email, Purpose purpose, String transactionSecret) {
        requireSecret(transactionSecret);
        if (purpose == null) throw new EphemeralFailure(INVALID_PROOF);
        String canonical = EmailAddress.canonicalize(email), challenge = TokenSecrets.generate(), secret = TokenSecrets.generate();
        String operation = UUID.randomUUID().toString();
        try {
            Long result = redis.execute(ISSUE, List.of(key(challenge)), operation, canonical, purpose.name(),
                    TokenSecrets.digest(transactionSecret), TokenSecrets.digest(secret), Long.toString(ttl.toMillis()));
            if (!Long.valueOf(1).equals(result)) throw new EphemeralFailure(UNAVAILABLE);
            return new Issued(challenge, secret);
        } catch (DataAccessException unavailable) { throw new EphemeralFailure(UNAVAILABLE); }
    }

    /** Only confirms mailbox possession; it cannot log in, change a password or choose a different transaction. */
    public void verifyLink(String challenge, String deliverySecret) {
        requireSecret(challenge); requireSecret(deliverySecret);
        try {
            if (!Long.valueOf(1).equals(redis.execute(VERIFY, List.of(key(challenge)), TokenSecrets.digest(deliverySecret))))
                throw new EphemeralFailure(INVALID_PROOF);
        } catch (DataAccessException unavailable) { throw new EphemeralFailure(UNAVAILABLE); }
    }

    public VerifiedMailbox consume(String challenge, Purpose purpose, String transactionSecret) {
        requireSecret(challenge); requireSecret(transactionSecret);
        if (purpose == null) throw new EphemeralFailure(INVALID_PROOF);
        try {
            var result = redis.execute(CONSUME, List.of(key(challenge)), purpose.name(), TokenSecrets.digest(transactionSecret));
            if (result == null || result.size() != 2) throw new EphemeralFailure(INVALID_PROOF);
            return new VerifiedMailbox((String) result.get(0), (String) result.get(1), purpose);
        } catch (DataAccessException unavailable) { throw new EphemeralFailure(UNAVAILABLE); }
    }

    String key(String challenge) { return prefix + "mailbox:" + TokenSecrets.digest(challenge); }
    private static void requireSecret(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{43}")) throw new EphemeralFailure(INVALID_PROOF);
    }
    static <T> DefaultRedisScript<T> script(String name, Class<T> resultType) {
        var script = new DefaultRedisScript<T>();
        script.setLocation(new ClassPathResource("redis/" + name));
        script.setResultType(resultType);
        return script;
    }
    public enum Purpose { REGISTER, PASSWORD_RESET, EXTERNAL_IDENTITY }
    public record Issued(String challenge, String deliverySecret) {
        @Override public String toString() { return "Issued[challenge=[REDACTED], deliverySecret=[REDACTED]]"; }
    }
    public static final class VerifiedMailbox {
        private final String operationId, email;
        private final Purpose purpose;
        private VerifiedMailbox(String operationId, String email, Purpose purpose) {
            this.operationId = operationId; this.email = email; this.purpose = purpose;
        }
        public String operationId() { return operationId; }
        public String email() { return email; }
        public Purpose purpose() { return purpose; }
        @Override public String toString() { return "VerifiedMailbox[purpose=" + purpose + ", email=[REDACTED]]"; }
    }
}
