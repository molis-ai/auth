package ai.molis.auth.oauth;

import ai.molis.auth.session.SessionService;
import org.springframework.dao.DataAccessException;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.server.authorization.authentication.*;
import org.springframework.transaction.TransactionException;

/** Standard Spring grant request/response objects around the durable transaction engine. */
final class DurableGrantAuthenticationProvider implements AuthenticationProvider {
    private final SessionService sessions;
    DurableGrantAuthenticationProvider(SessionService sessions) { this.sessions = sessions; }

    @Override public Authentication authenticate(Authentication authentication) {
        var grant = (OAuth2AuthorizationGrantAuthenticationToken) authentication;
        if (!(grant.getPrincipal() instanceof OAuth2ClientAuthenticationToken client)
                || !client.isAuthenticated() || client.getRegisteredClient() == null
                || !ClientAuthenticationMethod.NONE.equals(client.getClientAuthenticationMethod())) {
            throw new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_CLIENT);
        }
        try {
            SessionService.TokenPair tokens;
            String clientId = client.getRegisteredClient().getClientId();
            if (grant instanceof OAuth2AuthorizationCodeAuthenticationToken code) {
                Object verifier = code.getAdditionalParameters().get("code_verifier");
                tokens = sessions.exchangeCode(clientId, code.getCode(), code.getRedirectUri(),
                        verifier instanceof String value ? value : null);
            } else {
                var refresh = (OAuth2RefreshTokenAuthenticationToken) grant;
                tokens = sessions.rotate(clientId, refresh.getRefreshToken(), refresh.getScopes());
            }
            var access = new OAuth2AccessToken(OAuth2AccessToken.TokenType.BEARER, tokens.accessToken(),
                    tokens.issuedAt(), tokens.accessExpiresAt(), tokens.scopes());
            var refresh = new OAuth2RefreshToken(tokens.refreshToken(), tokens.issuedAt(), tokens.refreshExpiresAt());
            return new OAuth2AccessTokenAuthenticationToken(client.getRegisteredClient(), client, access, refresh);
        } catch (SessionService.SessionRejectedException rejected) {
            throw new OAuth2AuthenticationException(rejected.reason() == SessionService.Reason.INVALID_SCOPE
                    ? OAuth2ErrorCodes.INVALID_SCOPE : OAuth2ErrorCodes.INVALID_GRANT);
        } catch (DataAccessException | TransactionException unavailable) {
            throw ProtocolErrors.unavailable();
        }
    }

    @Override public boolean supports(Class<?> type) {
        return OAuth2AuthorizationCodeAuthenticationToken.class.isAssignableFrom(type)
                || OAuth2RefreshTokenAuthenticationToken.class.isAssignableFrom(type);
    }
}
