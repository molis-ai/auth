package ai.molis.auth.verification;

import ai.molis.auth.security.TokenSecrets;
import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;
import static ai.molis.auth.verification.EphemeralFailure.Reason.*;

/** Shared fixed-window limiter; no local fallback on Redis failure. Policy inputs are server-owned. */
@Component
@ConditionalOnProperty(name = "auth.ephemeral.enabled", havingValue = "true")
public class RedisRateLimiter {
    private static final DefaultRedisScript<List> SCRIPT = RedisMailboxProofs.script("rate-limit.lua", List.class);
    private final StringRedisTemplate redis;
    private final String prefix;
    @org.springframework.beans.factory.annotation.Autowired
    public RedisRateLimiter(StringRedisTemplate redis) { this(redis, "auth:v1:"); }
    RedisRateLimiter(StringRedisTemplate redis, String prefix) {
        if (!prefix.matches("[A-Za-z0-9:_-]{1,100}")) throw new IllegalArgumentException("Invalid limiter namespace");
        this.redis = redis; this.prefix = prefix;
    }
    public void acquire(Bucket bucket, String normalizedSubject) {
        acquire(bucket.name(), normalizedSubject, bucket.limit, bucket.windowMillis);
    }
    void acquire(String bucket, String subject, int limit, long windowMillis) {
        if (subject == null || subject.isBlank() || subject.length() > 1024 || limit < 1 || windowMillis < 1)
            throw new IllegalArgumentException("Invalid rate limit input");
        try {
            var result = redis.execute(SCRIPT, List.of(key(bucket, subject)), Integer.toString(limit), Long.toString(windowMillis));
            if (result == null || result.size() != 2) throw new EphemeralFailure(UNAVAILABLE);
            long allowed = ((Number) result.get(0)).longValue(), remainingMillis = ((Number) result.get(1)).longValue();
            if (allowed < 0) throw new EphemeralFailure(UNAVAILABLE);
            if (allowed == 0) throw new EphemeralFailure(RATE_LIMITED, Math.max(1, (remainingMillis + 999) / 1000));
        } catch (DataAccessException unavailable) { throw new EphemeralFailure(UNAVAILABLE); }
    }
    String key(String bucket, String subject) { return prefix + "limit:" + bucket + ":" + TokenSecrets.digest(subject); }
    // Initial implementation defaults, to be reviewed alongside deployment traffic limits.
    public enum Bucket {
        SERVICE_TOKEN_IP(120,60_000), SERVICE_TOKEN_CLIENT(30,60_000), AUTHORIZATION_IP(6000,60_000), AUTHORIZATION_TOKEN(3000,60_000),
        BEGIN_IP(60, 60_000), LOGIN_IP(60, 60_000), LOGIN_EMAIL(10, 60_000), MAIL_IP(20, 3_600_000), MAIL_EMAIL(3, 600_000), VERIFY_IP(60, 60_000), ACCOUNT_IP(30, 60_000),
        SPACE_CREATE_USER(20, 3_600_000), SPACE_INVITE_USER(20, 3_600_000), SPACE_SEARCH_USER(30,60_000), PROVIDER_CALLBACK_IP(60,60_000), CONFIRMATION_IP(60,60_000);
        private final int limit; private final long windowMillis;
        Bucket(int limit, long windowMillis) { this.limit = limit; this.windowMillis = windowMillis; }
    }
}
