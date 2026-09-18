package ai.molis.auth.protocol;

import ai.molis.auth.security.TokenSecrets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.server.authorization.*;

/**
 * Protocol experiment ONLY: hash-only snapshots and a JVM lock stand in for MySQL.
 * Not a production repository. The lock does not establish multi-machine correctness.
 */
final class HashOnlyAuthorizationFixture implements OAuth2AuthorizationService {
    private static final String HASHED = "auth.fixture.hashed";
    private static final List<Class<? extends OAuth2Token>> TYPES =
            List.of(OAuth2AuthorizationCode.class, OAuth2AccessToken.class, OAuth2RefreshToken.class);
    private final Map<String, OAuth2Authorization> rows = new HashMap<>();
    // Keep rotated-token lineage, not just the current refresh token.
    private final Map<String, String> tokenOwners = new HashMap<>();

    @Override
    public synchronized void save(OAuth2Authorization authorization) {
        var builder = OAuth2Authorization.from(authorization);
        for (var type : TYPES) {
            var token = authorization.getToken(type);
            if (token == null) continue;
            String hash = Boolean.TRUE.equals(token.getMetadata(HASHED))
                    ? token.getToken().getTokenValue() : TokenSecrets.digest(token.getToken().getTokenValue());
            tokenOwners.put(key(type, hash), authorization.getId());
            builder.token(withValue(token.getToken(), hash), metadata -> {
                metadata.putAll(token.getMetadata());
                metadata.put(HASHED, true);
            });
        }
        rows.put(authorization.getId(), builder.build());
    }

    @Override
    public synchronized void remove(OAuth2Authorization authorization) {
        rows.remove(authorization.getId());
        tokenOwners.values().removeIf(authorization.getId()::equals);
    }

    @Override
    public synchronized OAuth2Authorization findById(String id) {
        return rows.get(id);
    }

    @Override
    public synchronized OAuth2Authorization findByToken(String value, OAuth2TokenType tokenType) {
        String hash = TokenSecrets.digest(value);
        for (var type : TYPES) {
            if (tokenType != null && !typeName(type).equals(tokenType.getValue())) continue;
            String id = tokenOwners.get(key(type, hash));
            var row = rows.get(id);
            if (row == null) continue;
            var stored = row.getToken(type);
            // A rotated token still resolves to its family; the atomic exchange rejects it.
            if (stored == null || !stored.getToken().getTokenValue().equals(hash)) return row;
            return OAuth2Authorization.from(row)
                    .token(withValue(stored.getToken(), value), metadata -> {
                        metadata.putAll(stored.getMetadata());
                        metadata.put(HASHED, false);
                    }).build();
        }
        return null;
    }

    synchronized Authentication exchange(String registeredClientId, String value,
            Class<? extends OAuth2Token> type, Supplier<Authentication> operation) {
        String hash = TokenSecrets.digest(value);
        var row = rows.get(tokenOwners.get(key(type, hash)));
        if (row == null || !row.getRegisteredClientId().equals(registeredClientId)) {
            throw new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_GRANT);
        }
        if (type == OAuth2RefreshToken.class
                && !row.getRefreshToken().getToken().getTokenValue().equals(hash)) {
            // Commit revocation even though the exchange fails. Production transaction
            // semantics must not roll this back together with invalid_grant.
            save(OAuth2Authorization.from(row).invalidate(row.getRefreshToken().getToken()).build());
            throw new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_GRANT);
        }
        return operation.get();
    }

    synchronized void clear() {
        rows.clear();
        tokenOwners.clear();
    }

    private static String key(Class<?> type, String hash) {
        return type.getSimpleName() + ":" + hash;
    }

    private static String typeName(Class<?> type) {
        if (type == OAuth2AuthorizationCode.class) return "code";
        if (type == OAuth2AccessToken.class) return "access_token";
        return "refresh_token";
    }

    private static OAuth2Token withValue(OAuth2Token token, String value) {
        if (token instanceof OAuth2AuthorizationCode) {
            return new OAuth2AuthorizationCode(value, token.getIssuedAt(), token.getExpiresAt());
        }
        if (token instanceof OAuth2AccessToken access) {
            return new OAuth2AccessToken(access.getTokenType(), value,
                    token.getIssuedAt(), token.getExpiresAt(), access.getScopes());
        }
        if (token instanceof OAuth2RefreshToken) {
            return new OAuth2RefreshToken(value, token.getIssuedAt(), token.getExpiresAt());
        }
        throw new IllegalArgumentException("Unsupported token class");
    }
}
