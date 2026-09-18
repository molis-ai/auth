package ai.molis.auth.oauth;

import ai.molis.auth.service.ServiceIdentityService;
import org.springframework.dao.DataAccessException;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.server.authorization.authentication.*;
import org.springframework.transaction.TransactionException;

final class ServiceGrantAuthenticationProvider implements AuthenticationProvider {
    private final ServiceIdentityService services;
    ServiceGrantAuthenticationProvider(ServiceIdentityService services){this.services=services;}
    @Override public Authentication authenticate(Authentication authentication) {
        var request=(OAuth2ClientCredentialsAuthenticationToken)authentication;
        if(!(request.getPrincipal() instanceof ServiceClientAuthentication.Verified client)||!client.isAuthenticated())
            throw new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_CLIENT);
        try {
            var token=services.issue(client.identity(),request.getScopes(),client.requestId());
            var access=new OAuth2AccessToken(OAuth2AccessToken.TokenType.BEARER,token.accessToken(),token.issuedAt(),token.expiresAt(),token.scopes());
            return new OAuth2AccessTokenAuthenticationToken(client.getRegisteredClient(),client,access);
        } catch(ServiceIdentityService.Rejected rejected){throw new OAuth2AuthenticationException(rejected.reason()==ServiceIdentityService.Reason.INVALID_SCOPE?OAuth2ErrorCodes.INVALID_SCOPE:OAuth2ErrorCodes.INVALID_CLIENT);}
        catch(DataAccessException|TransactionException unavailable){throw ProtocolErrors.unavailable();}
    }
    @Override public boolean supports(Class<?> type){return OAuth2ClientCredentialsAuthenticationToken.class.isAssignableFrom(type);}
}
