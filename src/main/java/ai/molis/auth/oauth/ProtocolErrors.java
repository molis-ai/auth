package ai.molis.auth.oauth;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.server.authorization.web.authentication.OAuth2ErrorAuthenticationFailureHandler;
import org.springframework.security.web.authentication.AuthenticationFailureHandler;

final class ProtocolErrors implements AuthenticationFailureHandler {
    private final ai.molis.auth.service.ServiceIdentityService services;
    ProtocolErrors(){this(null);}
    ProtocolErrors(ai.molis.auth.service.ServiceIdentityService services){this.services=services;}
    private final OAuth2ErrorAuthenticationFailureHandler standard = new OAuth2ErrorAuthenticationFailureHandler();

    static OAuth2AuthenticationException unavailable() {
        return new OAuth2AuthenticationException(new OAuth2Error("temporarily_unavailable"));
    }

    @Override public void onAuthenticationFailure(HttpServletRequest request, HttpServletResponse response,
            AuthenticationException failure) throws IOException, ServletException {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Pragma", "no-cache");
        if(services!=null&&"client_credentials".equals(request.getParameter("grant_type"))
                &&failure instanceof OAuth2AuthenticationException oauth
                &&java.util.Set.of("invalid_client","invalid_scope","invalid_request","rate_limited").contains(oauth.getError().getErrorCode())) {
            String id=(String)request.getAttribute(ai.molis.auth.login.AuthHttpBoundary.REQUEST_ID);
            if(id==null){id=java.util.UUID.randomUUID().toString();response.setHeader("X-Request-ID",id);}
            try { services.authenticationDenied(id,oauth.getError().getErrorCode()); }
            catch(org.springframework.dao.DataAccessException|org.springframework.transaction.TransactionException unavailable){failure=unavailable();}
        }
        if(failure instanceof OAuth2AuthenticationException oauth&&"rate_limited".equals(oauth.getError().getErrorCode())) {
            response.setStatus(429);response.setHeader("Retry-After","60");response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"rate_limited\"}");return;
        }
        if (failure instanceof OAuth2AuthenticationException oauth
                && OAuth2ErrorCodes.INVALID_CLIENT.equals(oauth.getError().getErrorCode())
                && ("client_credentials".equals(request.getParameter("grant_type")) || request.getHeader("Authorization") != null)) {
            response.setStatus(401);
            response.setHeader("WWW-Authenticate", "Basic realm=\"Auth\"");
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"invalid_client\"}");
            return;
        }
        if (failure instanceof OAuth2AuthenticationException oauth
                && "temporarily_unavailable".equals(oauth.getError().getErrorCode())) {
            response.setStatus(503);
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"temporarily_unavailable\"}");
            return;
        }
        standard.onAuthenticationFailure(request, response, failure);
    }
}
