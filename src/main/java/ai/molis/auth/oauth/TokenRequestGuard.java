package ai.molis.auth.oauth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Set;
import org.springframework.http.MediaType;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2ErrorCodes;
import org.springframework.web.filter.OncePerRequestFilter;

final class TokenRequestGuard extends OncePerRequestFilter {
    private static final Set<String> SINGLE = Set.of("grant_type", "client_id", "code", "code_verifier",
            "redirect_uri", "refresh_token", "scope", "client_secret", "client_assertion", "client_assertion_type");
    private final boolean localDevelopment;
    private final ProtocolErrors errors;
    TokenRequestGuard(boolean localDevelopment) { this(localDevelopment,new ProtocolErrors()); }
    TokenRequestGuard(boolean localDevelopment,ProtocolErrors errors) { this.localDevelopment = localDevelopment;this.errors=errors; }

    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String requestId=java.util.UUID.randomUUID().toString();
        request.setAttribute(ai.molis.auth.login.AuthHttpBoundary.REQUEST_ID,requestId);
        response.setHeader("X-Request-ID",requestId);
        if (!valid(request)) {
            errors.onAuthenticationFailure(request, response,
                    new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_REQUEST));
            return;
        }
        chain.doFilter(request, response);
    }

    private boolean valid(HttpServletRequest request) {
        boolean loopback = request.getRemoteAddr() != null
                && Set.of("127.0.0.1", "::1", "0:0:0:0:0:0:0:1").contains(request.getRemoteAddr());
        if (!request.isSecure() && !(localDevelopment && loopback)) return false;
        if (request.getQueryString() != null && !request.getQueryString().isEmpty()) return false;
        if (request.getHeader("DPoP") != null || request.getContentLengthLong() > 16384) return false;
        try {
            if (request.getContentType() == null) return false;
            var type = MediaType.parseMediaType(request.getContentType());
            if (!"application".equals(type.getType()) || !"x-www-form-urlencoded".equals(type.getSubtype())) return false;
        } catch (IllegalArgumentException invalid) {
            return false;
        }
        int length = 0;
        for (var entry : request.getParameterMap().entrySet()) {
            if (SINGLE.contains(entry.getKey()) && entry.getValue().length != 1) return false;
            length += entry.getKey().length();
            for (String value : entry.getValue()) length += value.length();
            if (length > 8192) return false;
        }
        return true;
    }
}
