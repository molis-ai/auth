package ai.molis.auth.protocol;

import ai.molis.auth.security.TokenSecrets;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.server.authorization.*;
import org.springframework.security.oauth2.server.authorization.authentication.*;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClientRepository;
import org.springframework.security.oauth2.server.authorization.token.OAuth2TokenContext;
import org.springframework.security.oauth2.server.authorization.token.OAuth2TokenGenerator;
import org.springframework.security.web.authentication.AuthenticationConverter;

/** Test-only extension. Production needs durable atomic rotation and AuthSession validation. */
final class PublicRefreshFixture implements AuthenticationConverter, AuthenticationProvider {
    private final RegisteredClientRepository clients;
    private final HashOnlyAuthorizationFixture store;

    PublicRefreshFixture(RegisteredClientRepository clients, HashOnlyAuthorizationFixture store) {
        this.clients = clients;
        this.store = store;
    }

    @Override
    public Authentication convert(HttpServletRequest request) {
        if (!"refresh_token".equals(request.getParameter("grant_type"))) return null;
        // Leave confidential authentication to the framework. No mixed auth mechanisms.
        if (request.getHeader("Authorization") != null || request.getParameter("client_secret") != null
                || request.getParameter("client_assertion") != null) return null;
        String grant = single(request, "grant_type");
        String clientId = single(request, "client_id");
        String refresh = single(request, "refresh_token");
        return new PublicRefreshClient(clientId, Map.of("grant_type", grant, "refresh_token", refresh));
    }

    @Override
    public Authentication authenticate(Authentication authentication) {
        var request = (PublicRefreshClient) authentication;
        var client = clients.findByClientId(request.getPrincipal().toString());
        if (client == null || !client.getClientAuthenticationMethods().equals(Set.of(ClientAuthenticationMethod.NONE))
                || !client.getClientSettings().isRequireProofKey()
                || client.getTokenSettings().isReuseRefreshTokens()
                || !client.getAuthorizationGrantTypes().contains(AuthorizationGrantType.REFRESH_TOKEN)) {
            throw new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_CLIENT);
        }
        String token = (String) request.getAdditionalParameters().get("refresh_token");
        var authorization = store.findByToken(token, OAuth2TokenType.REFRESH_TOKEN);
        if (authorization == null || !client.getId().equals(authorization.getRegisteredClientId())) {
            throw new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_GRANT);
        }
        // NONE identifies a public client; it does not establish possession of a secret.
        // The grant provider must still validate/consume the refresh token atomically.
        return new OAuth2ClientAuthenticationToken(client, ClientAuthenticationMethod.NONE, null);
    }

    @Override
    public boolean supports(Class<?> type) {
        return type == PublicRefreshClient.class;
    }

    private static String single(HttpServletRequest request, String name) {
        var values = request.getParameterValues(name);
        if (values == null || values.length != 1 || values[0].isBlank()) {
            throw new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_REQUEST);
        }
        return values[0];
    }

    private static final class PublicRefreshClient extends OAuth2ClientAuthenticationToken {
        PublicRefreshClient(String clientId, Map<String, Object> parameters) {
            super(clientId, ClientAuthenticationMethod.NONE, null, parameters);
        }
    }

    static OAuth2TokenGenerator<OAuth2RefreshToken> refreshGenerator() {
        return (OAuth2TokenContext context) -> {
            if (!OAuth2TokenType.REFRESH_TOKEN.equals(context.getTokenType())) return null;
            if (context.getRegisteredClient().getTokenSettings().isReuseRefreshTokens()) {
                throw new IllegalStateException("Rotation must be enabled");
            }
            Instant now = Instant.now();
            return new OAuth2RefreshToken(TokenSecrets.generate(), now,
                    now.plus(context.getRegisteredClient().getTokenSettings().getRefreshTokenTimeToLive()));
        };
    }

    static AuthenticationProvider atomic(AuthenticationProvider delegate, HashOnlyAuthorizationFixture store) {
        return new AuthenticationProvider() {
            @Override
            public Authentication authenticate(Authentication authentication) {
                if (authentication instanceof OAuth2AuthorizationCodeAuthenticationToken code) {
                    var client = (OAuth2ClientAuthenticationToken) code.getPrincipal();
                    return store.exchange(client.getRegisteredClient().getId(), code.getCode(),
                            OAuth2AuthorizationCode.class, () -> delegate.authenticate(authentication));
                }
                var refresh = (OAuth2RefreshTokenAuthenticationToken) authentication;
                var client = (OAuth2ClientAuthenticationToken) refresh.getPrincipal();
                return store.exchange(client.getRegisteredClient().getId(), refresh.getRefreshToken(),
                        OAuth2RefreshToken.class, () -> delegate.authenticate(authentication));
            }

            @Override
            public boolean supports(Class<?> type) {
                return delegate.supports(type);
            }
        };
    }
}
