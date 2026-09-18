package ai.molis.auth.oauth;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.Set;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2ClientAuthenticationToken;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClientRepository;
import org.springframework.security.web.authentication.AuthenticationConverter;

/** Recognizes only the public refresh flow; NONE never proves possession of a client secret. */
final class PublicRefreshAuthentication implements AuthenticationConverter, AuthenticationProvider {
    private final RegisteredClientRepository clients;
    PublicRefreshAuthentication(RegisteredClientRepository clients) { this.clients = clients; }

    @Override public Authentication convert(HttpServletRequest request) {
        if (!"refresh_token".equals(request.getParameter("grant_type"))) return null;
        if (request.getHeader("Authorization") != null || request.getParameter("client_secret") != null
                || request.getParameter("client_assertion") != null) return null;
        return new RefreshClient(single(request, "client_id"),
                Map.of("grant_type", single(request, "grant_type"), "refresh_token", single(request, "refresh_token")));
    }

    @Override public Authentication authenticate(Authentication authentication) {
        var request = (RefreshClient) authentication;
        var client = clients.findByClientId(request.getPrincipal().toString());
        if (client == null || !client.getClientAuthenticationMethods().equals(Set.of(ClientAuthenticationMethod.NONE))
                || !client.getAuthorizationGrantTypes().contains(AuthorizationGrantType.REFRESH_TOKEN)
                || !client.getClientSettings().isRequireProofKey() || client.getTokenSettings().isReuseRefreshTokens()) {
            throw new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_CLIENT);
        }
        // The grant provider still validates the token's client binding and consumes it atomically.
        return new OAuth2ClientAuthenticationToken(client, ClientAuthenticationMethod.NONE, null);
    }

    @Override public boolean supports(Class<?> type) { return type == RefreshClient.class; }

    private static String single(HttpServletRequest request, String name) {
        String[] values = request.getParameterValues(name);
        if (values == null || values.length != 1 || values[0].isBlank()) {
            throw new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_REQUEST);
        }
        return values[0];
    }

    private static final class RefreshClient extends OAuth2ClientAuthenticationToken {
        RefreshClient(String clientId, Map<String, Object> parameters) {
            super(clientId, ClientAuthenticationMethod.NONE, null, parameters);
        }
    }
}
