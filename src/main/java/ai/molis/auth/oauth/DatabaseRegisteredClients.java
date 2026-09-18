package ai.molis.auth.oauth;

import java.time.Duration;
import java.util.Arrays;
import org.springframework.dao.DataAccessException;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.server.authorization.client.*;
import org.springframework.security.oauth2.server.authorization.settings.*;
import org.springframework.stereotype.Repository;

@Repository
public class DatabaseRegisteredClients implements RegisteredClientRepository {
    private final ClientRegistryMapper mapper;
    public DatabaseRegisteredClients(ClientRegistryMapper mapper) { this.mapper = mapper; }

    @Override public RegisteredClient findById(String id) {
        try { return map(mapper.findById(id)); }
        catch (DataAccessException unavailable) { throw ProtocolErrors.unavailable(); }
    }

    @Override public RegisteredClient findByClientId(String clientId) {
        try {
            var row = mapper.findByClientId(clientId);
            return row != null && row.clientId().equals(clientId) ? map(row) : null;
        }
        catch (DataAccessException unavailable) { throw ProtocolErrors.unavailable(); }
    }

    @Override public void save(RegisteredClient client) {
        throw new UnsupportedOperationException("Use the authorized application-management workflow");
    }

    private RegisteredClient map(ClientRegistryMapper.ClientRow row) {
        if (row == null) return null;
        var redirects = mapper.redirects(row.id());
        if (redirects.isEmpty()) return null;
        return RegisteredClient.withId(row.id()).clientId(row.clientId())
                .clientAuthenticationMethod(ClientAuthenticationMethod.NONE)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
                .redirectUris(values -> values.addAll(redirects))
                .scopes(values -> values.addAll(Arrays.asList(row.allowedScopes().split(" "))))
                .clientSettings(ClientSettings.builder().requireProofKey(true).requireAuthorizationConsent(false).build())
                .tokenSettings(TokenSettings.builder().accessTokenFormat(OAuth2TokenFormat.REFERENCE)
                        .accessTokenTimeToLive(Duration.ofMinutes(15)).refreshTokenTimeToLive(Duration.ofDays(30))
                        .reuseRefreshTokens(false).build()).build();
    }
}
