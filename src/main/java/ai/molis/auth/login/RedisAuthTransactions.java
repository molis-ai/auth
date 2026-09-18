package ai.molis.auth.login;

import ai.molis.auth.security.TokenSecrets;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

@Component
@ConditionalOnProperty(name = "auth.login.enabled", havingValue = "true")
public final class RedisAuthTransactions {
    private static final DefaultRedisScript<List> SCRIPT = new DefaultRedisScript<>();
    private static final JsonMapper JSON = JsonMapper.builder().build();
    static { SCRIPT.setLocation(new ClassPathResource("redis/auth-transaction.lua")); SCRIPT.setResultType(List.class); }
    private final StringRedisTemplate redis;
    public RedisAuthTransactions(StringRedisTemplate redis) { this.redis = redis; }

    public String create(Context context) {
        String token = TokenSecrets.generate();
        execute(token, "create", JSON.writeValueAsString(context));
        return token;
    }
    public View read(String token) {
        var result = execute(token, "read");
        return new View(parse(result.get(0)), (String) result.get(1));
    }
    public Claim claim(String token) {
        String owner = UUID.randomUUID().toString();
        var result = execute(token, "claim", owner);
        return new Claim(parse(result.get(0)), owner);
    }
    /** Recheck an outstanding claim before an external authentication result is accepted. */
    public Context owned(String token, String owner) {
        if (owner == null || !owner.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw LoginFailure.invalid();
        return parse(execute(token, "owned", owner).getFirst());
    }
    public void authenticated(String token, String owner, String root) { execute(token, "authenticated", owner, root); }
    public void denied(String token, String owner) { execute(token, "denied", owner); }
    public void finish(String token, String owner) { execute(token, "finish", owner); }
    public Completed consume(String token) {
        var result = execute(token, "complete");
        return new Completed(parse(result.get(0)), (String) result.get(1));
    }
    public Completed preview(String token) {
        var result = execute(token, "preview");
        return new Completed(parse(result.get(0)), (String) result.get(1));
    }
    public long bindCompletion(String token, String browser, String proof, String root) {
        var result = execute(token, "bind-completion", hashSecret(browser), hashSecret(proof), root);
        return Long.parseLong((String) result.getFirst());
    }
    public Completed consumeConfirmed(String token, String browser, String proof) {
        var result = execute(token, "confirmed-complete", hashSecret(browser), hashSecret(proof));
        return new Completed(parse(result.get(0)), (String) result.get(1));
    }
    private static String hashSecret(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{43}")) throw LoginFailure.invalid();
        return TokenSecrets.digest(value);
    }
    private List<?> execute(String token, String... arguments) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) throw LoginFailure.invalid();
        try {
            var result = redis.execute(SCRIPT, List.of("auth:v1:transaction:" + TokenSecrets.digest(token)), (Object[]) arguments);
            if (result == null || result.isEmpty()) throw LoginFailure.invalid();
            return result;
        } catch (DataAccessException unavailable) { throw new LoginFailure(503, "AUTH_UNAVAILABLE"); }
    }
    private static Context parse(Object value) {
        try { return JSON.readValue((String) value, Context.class); }
        catch (RuntimeException invalid) { throw LoginFailure.invalid(); }
    }
    public record Context(String id, String clientId, String clientType, String redirectUri, String challenge,
                          String state, Set<String> scopes, boolean forceLogin) {
        public Context { scopes = Set.copyOf(scopes); }
    }
    public record View(Context context, String status) {}
    public record Claim(Context context, String owner) {}
    public record Completed(Context context, String root) {}
}
