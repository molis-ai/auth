package ai.molis.auth.oauth;

import ai.molis.auth.service.ServiceIdentityService;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Collections;
import org.springframework.dao.DataAccessException;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2ClientAuthenticationToken;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClient;
import org.springframework.security.web.authentication.AuthenticationConverter;
import org.springframework.transaction.TransactionException;

/** Only backend Basic authentication for client_credentials. Public user clients cannot enter this path. */
final class ServiceClientAuthentication implements AuthenticationConverter,AuthenticationProvider {
    private final ServiceIdentityService services;
    private final org.springframework.beans.factory.ObjectProvider<ai.molis.auth.verification.RedisRateLimiter> limiter;
    ServiceClientAuthentication(ServiceIdentityService services,org.springframework.beans.factory.ObjectProvider<ai.molis.auth.verification.RedisRateLimiter> limiter){this.services=services;this.limiter=limiter;}
    @Override public Authentication convert(HttpServletRequest request) {
        if(!"client_credentials".equals(request.getParameter("grant_type")))return null;
        acquire(ai.molis.auth.verification.RedisRateLimiter.Bucket.SERVICE_TOKEN_IP,request.getRemoteAddr());
        if(request.getHeader("Origin")!=null||request.getParameter("client_id")!=null||request.getParameter("client_secret")!=null
                ||request.getParameter("client_assertion")!=null||request.getParameter("refresh_token")!=null||request.getParameter("code")!=null)throw invalid();
        var headers=Collections.list(request.getHeaders("Authorization"));
        if(headers.size()!=1||headers.getFirst().length()>512||!headers.getFirst().matches("(?i:Basic) [A-Za-z0-9+/]+={0,2}"))throw invalid();
        try {
            String decoded=new String(Base64.getDecoder().decode(headers.getFirst().substring(6)),StandardCharsets.UTF_8);
            int separator=decoded.indexOf(':');if(separator<1||decoded.length()>256)throw invalid();
            String id=URLDecoder.decode(decoded.substring(0,separator),StandardCharsets.UTF_8);
            String secret=URLDecoder.decode(decoded.substring(separator+1),StandardCharsets.UTF_8);
            acquire(ai.molis.auth.verification.RedisRateLimiter.Bucket.SERVICE_TOKEN_CLIENT,id);
            return new Request(id,secret,(String)request.getAttribute(ai.molis.auth.login.AuthHttpBoundary.REQUEST_ID));
        } catch(IllegalArgumentException bad){throw invalid();}
    }
    @Override public Authentication authenticate(Authentication input) {
        var request=(Request)input;
        try {
            var identity=services.authenticate(request.getPrincipal().toString(),request.getCredentials().toString());
            var client=RegisteredClient.withId(identity.id()).clientId(identity.clientId())
                    .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                    .authorizationGrantType(AuthorizationGrantType.CLIENT_CREDENTIALS).scope(ServiceIdentityService.AUTHORIZATION_SCOPE).build();
            return new Verified(client,identity,request.requestId);
        } catch(ServiceIdentityService.Rejected rejected){throw invalid();}
        catch(DataAccessException|TransactionException unavailable){throw ProtocolErrors.unavailable();}
        finally{request.eraseCredentials();}
    }
    @Override public boolean supports(Class<?> type){return type==Request.class;}
    private void acquire(ai.molis.auth.verification.RedisRateLimiter.Bucket bucket,String subject){
        var active=limiter.getIfAvailable();if(active==null)throw ProtocolErrors.unavailable();
        try {active.acquire(bucket,subject);}
        catch(ai.molis.auth.verification.EphemeralFailure failure){
            if(failure.reason()==ai.molis.auth.verification.EphemeralFailure.Reason.RATE_LIMITED)
                throw new OAuth2AuthenticationException(new OAuth2Error("rate_limited"));
            throw ProtocolErrors.unavailable();
        }
    }
    private static OAuth2AuthenticationException invalid(){return new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_CLIENT);}
    // Not a generic OAuth2ClientAuthenticationToken: other framework providers must not retry
    // this request after our database-unavailable or invalid-credential result.
    private static final class Request extends org.springframework.security.authentication.AbstractAuthenticationToken {
        private final String requestId;
        private final String clientId;
        private String secret;
        Request(String id,String secret,String requestId){super(java.util.List.of());this.clientId=id;this.secret=secret;this.requestId=requestId;}
        @Override public Object getPrincipal(){return clientId;}
        @Override public Object getCredentials(){return secret;}
        @Override public void eraseCredentials(){super.eraseCredentials();secret=null;}
    }
    static final class Verified extends OAuth2ClientAuthenticationToken {
        private final ServiceIdentityService.Authenticated identity;
        private final String requestId;
        Verified(RegisteredClient client,ServiceIdentityService.Authenticated identity,String requestId){super(client,ClientAuthenticationMethod.CLIENT_SECRET_BASIC,null);this.identity=identity;this.requestId=requestId;}
        ServiceIdentityService.Authenticated identity(){return identity;}
        String requestId(){return requestId;}
    }
}
