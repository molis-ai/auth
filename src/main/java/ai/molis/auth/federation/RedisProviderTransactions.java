package ai.molis.auth.federation;

import ai.molis.auth.security.TokenSecrets;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

/**
 * Internal single-use store, intentionally not a Bean or an HTTP endpoint.
 * A coordinator must first claim/validate the Auth transaction and establish a browser-only binding.
 * A returned state alone is NEVER a browser binding; do not put that binding in an authorization URL.
 */
public final class RedisProviderTransactions {
    private static final DefaultRedisScript<List> SCRIPT = new DefaultRedisScript<>();
    private static final JsonMapper JSON = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    static { SCRIPT.setLocation(new ClassPathResource("redis/provider-transaction.lua")); SCRIPT.setResultType(List.class); }
    private final StringRedisTemplate redis;
    private final ProviderStateCipher cipher;
    private final Clock clock;
    private final String prefix;

    public RedisProviderTransactions(StringRedisTemplate redis, ProviderStateCipher cipher, Clock clock) {
        this(redis, cipher, clock, "auth:v1:provider-transaction:");
    }
    RedisProviderTransactions(StringRedisTemplate redis, ProviderStateCipher cipher, Clock clock, String prefix) {
        this.redis = Objects.requireNonNull(redis); this.cipher = Objects.requireNonNull(cipher);
        this.clock = Objects.requireNonNull(clock); this.prefix = Objects.requireNonNull(prefix);
        if (!prefix.matches("[A-Za-z0-9:_-]{1,160}")) throw new IllegalArgumentException("Invalid transaction namespace");
    }

    public Issued create(ProviderRegistration registration, String authTransaction, String claimOwner, String browserBinding) {
        return create(registration,authTransaction,claimOwner,browserBinding,null);
    }
    Issued create(ProviderRegistration registration, String authTransaction, String claimOwner, String browserBinding,ExternalAccountService.BindingTarget target) {
        return create(registration,authTransaction,claimOwner,browserBinding,target,null);
    }
    Issued create(ProviderRegistration registration,String authTransaction,String claimOwner,String browserBinding,ExternalAccountService.BindingTarget target,Link link) {
        Objects.requireNonNull(registration); opaque(authTransaction); opaque(browserBinding); owner(claimOwner);
        String state = TokenSecrets.generate();
        var pending = new Pending(authTransaction, claimOwner, TokenSecrets.generate(),
                registration.provider() == IdentityProvider.GOOGLE ? TokenSecrets.generate() : null, clock.instant().getEpochSecond(),target,link);
        String binding = binding(registration, browserBinding);
        String envelope = cipher.seal(JSON.writeValueAsString(pending), key(state) + "\n" + binding);
        execute(state, "create", binding, envelope);
        return new Issued(state, pending);
    }

    /** Destructive claim before any token exchange, including an error/cancel callback. No automatic retry. */
    public Pending consume(String state, ProviderRegistration registration, String browserBinding) {
        Objects.requireNonNull(registration); opaque(state); opaque(browserBinding);
        String binding = binding(registration, browserBinding);
        var result = execute(state, "consume", binding);
        try {
            var pending = JSON.readValue(cipher.open((String) result.getFirst(), key(state) + "\n" + binding), Pending.class);
            opaque(pending.authTransaction()); owner(pending.claimOwner()); opaque(pending.nonce());
            if(pending.link()!=null){if(pending.target()!=null)throw invalid();opaque(pending.link().state());opaque(pending.link().browser());}
            if(pending.target()!=null){owner(pending.target().userId());owner(pending.target().grantId());
                if(pending.target().clientId()==null||!pending.target().clientId().matches("[A-Za-z0-9][A-Za-z0-9_.-]{0,99}"))throw invalid();}
            if (registration.provider() == IdentityProvider.GOOGLE) opaque(pending.verifier());
            else if (pending.verifier() != null) throw invalid();
            Instant start = pending.startedAt(); Instant now = clock.instant();
            if (start.isAfter(now.plusSeconds(60)) || !now.isBefore(start.plusSeconds(300))) throw invalid();
            return pending;
        } catch (RuntimeException malformed) { throw invalid(); }
    }

    String key(String state) { opaque(state); return prefix + TokenSecrets.digest(state); }
    private List<?> execute(String state, String... arguments) {
        try {
            var result = redis.execute(SCRIPT, List.of(key(state)), (Object[]) arguments);
            if (result == null || result.isEmpty()) throw invalid();
            return result;
        } catch (DataAccessException unavailable) { throw new ExternalFailure("AUTH_UNAVAILABLE"); }
    }
    private static String binding(ProviderRegistration registration, String browserBinding) {
        return TokenSecrets.digest(registration.provider().name() + "\n" + registration.clientId() + "\n"
                + registration.callback().toASCIIString() + "\n" + browserBinding);
    }
    private static void opaque(String value) { if (value == null || !value.matches("[A-Za-z0-9_-]{43}")) throw invalid(); }
    private static void owner(String value) {
        try { if (value == null || !UUID.fromString(value).toString().equals(value)) throw invalid(); }
        catch (IllegalArgumentException malformed) { throw invalid(); }
    }
    private static ExternalFailure invalid() { return new ExternalFailure("PROVIDER_TRANSACTION_INVALID"); }

    record Link(String state,String browser){@Override public String toString(){return "Link[REDACTED]";}}
    public record Pending(String authTransaction, String claimOwner, String nonce, String verifier, long startedAtEpochSecond,ExternalAccountService.BindingTarget target,Link link) {
        public Pending(String authTransaction,String claimOwner,String nonce,String verifier,long startedAtEpochSecond){this(authTransaction,claimOwner,nonce,verifier,startedAtEpochSecond,null,null);}
        public Pending(String authTransaction,String claimOwner,String nonce,String verifier,long startedAtEpochSecond,ExternalAccountService.BindingTarget target){this(authTransaction,claimOwner,nonce,verifier,startedAtEpochSecond,target,null);}
        public Instant startedAt() { return Instant.ofEpochSecond(startedAtEpochSecond); }
        @Override public String toString() { return "Pending[REDACTED]"; }
    }
    public record Issued(String state, Pending pending) {
        @Override public String toString() { return "Issued[REDACTED]"; }
    }
}
