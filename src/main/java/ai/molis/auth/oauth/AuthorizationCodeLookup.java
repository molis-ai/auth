package ai.molis.auth.oauth;

import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.AuthorizationCodeMapper;
import ai.molis.auth.session.SessionMapper;
import java.security.Principal;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.dao.DataAccessException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;
import org.springframework.security.oauth2.server.authorization.*;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClientRepository;
import org.springframework.stereotype.Service;

/** Read adapter for Spring's official public-client PKCE verifier. No serialized authorizations. */
@Service
public final class AuthorizationCodeLookup implements OAuth2AuthorizationService {
    private final AuthorizationCodeMapper codes;
    private final SessionMapper sessions;
    private final RegisteredClientRepository clients;

    public AuthorizationCodeLookup(AuthorizationCodeMapper codes, SessionMapper sessions, RegisteredClientRepository clients) {
        this.codes = codes;
        this.sessions = sessions;
        this.clients = clients;
    }

    @Override public OAuth2Authorization findByToken(String token, OAuth2TokenType tokenType) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")
                || tokenType != null && !"code".equals(tokenType.getValue())) return null;
        try {
            var code = codes.find(TokenSecrets.digest(token));
            if (code == null) return null;
            var grant = sessions.findGrant(code.sessionId());
            if (grant == null) return null;
            var client = clients.findByClientId(grant.clientId());
            if (client == null) return null;
            Set<String> scopes = Set.copyOf(Arrays.asList(grant.scopes().split(" ")));
            var request = OAuth2AuthorizationRequest.authorizationCode()
                    .authorizationUri("urn:molis:auth:verified-transaction")
                    .clientId(grant.clientId()).redirectUri(code.redirectUri()).scopes(scopes)
                    .additionalParameters(Map.of("code_challenge", code.pkceChallenge(), "code_challenge_method", "S256"))
                    .build();
            return OAuth2Authorization.withRegisteredClient(client).id(grant.sessionId())
                    .principalName(grant.userId()).authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                    .authorizedScopes(scopes)
                    .attribute(OAuth2AuthorizationRequest.class.getName(), request)
                    .attribute(Principal.class.getName(),
                            UsernamePasswordAuthenticationToken.authenticated(grant.userId(), null, List.of()))
                    .token(new OAuth2AuthorizationCode(token, code.issuedAt(), code.expiresAt()),
                            metadata -> metadata.put(OAuth2Authorization.Token.INVALIDATED_METADATA_NAME, code.consumedAt() != null))
                    .build();
        } catch (DataAccessException unavailable) {
            throw ProtocolErrors.unavailable();
        }
    }

    @Override public OAuth2Authorization findById(String id) { return null; }
    @Override public void save(OAuth2Authorization authorization) {
        throw new UnsupportedOperationException("Only the atomic session/code workflow may issue tokens");
    }
    @Override public void remove(OAuth2Authorization authorization) {
        throw new UnsupportedOperationException("Use session revocation");
    }
}
