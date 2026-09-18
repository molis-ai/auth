package ai.molis.auth.login;

import ai.molis.auth.oauth.ClientRegistryMapper;
import ai.molis.auth.security.Pkce;
import ai.molis.auth.security.TokenSecrets;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class LoginPolicyTests {
    @Test void publicTopLevelPagesAcceptCrossSiteNavigationWithoutGrantingCorsAccess() throws Exception {
        var policy = new LoginClientPolicy(mock(ClientRegistryMapper.class), "https://auth.example");
        for (String page : List.of("/", "/login", "/provider", "/register", "/forgot-password", "/complete", "/verify-email", "/console", "/console/callback")) {
            for (String origin : List.of("absent", "null", "https://accounts.google.com", "https://independent-product.test")) {
                var request = navigation("GET", page, "navigate", "document");
                if (!origin.equals("absent")) request.addHeader("Origin", origin);
                var response = new MockHttpServletResponse(); var ran = new AtomicBoolean();
                new AuthHttpBoundary(policy, false).doFilter(request, response, (a, b) -> ran.set(true));
                assertThat(ran).as(page + " / " + origin).isTrue();
                assertThat(response.getHeader("Access-Control-Allow-Origin")).isNull();
            }
        }
    }
    @Test void publicNavigationExceptionNeverAppliesToApisFramesPostsOrDuplicateOrigins() throws Exception {
        var policy = new LoginClientPolicy(mock(ClientRegistryMapper.class), "https://auth.example");
        var requests = List.of(navigation("POST", "/login", "navigate", "document"),
                navigation("GET", "/complete", "navigate", "iframe"),
                navigation("GET", "/api/v1/auth/ui-configuration", "navigate", "document"),
                navigation("GET", "/oauth2/token", "navigate", "document"),
                navigation("GET", "/auth-ui/assets/app.js", "navigate", "document"),
                navigation("GET", "/login", "navigate", "iframe"),
                navigation("GET", "/provider", "cors", "document"),
                navigation("GET", "/login", "navigate", ""));
        for (var request : requests) {
            var response = new MockHttpServletResponse();
            new AuthHttpBoundary(policy, false).doFilter(request, response, (a, b) -> fail("Boundary bypass"));
            assertThat(response.getStatus()).isEqualTo(403);
        }
        var duplicate = navigation("GET", "/login", "navigate", "document");
        duplicate.addHeader("Origin", "https://auth.example"); duplicate.addHeader("Origin", "https://auth.example");
        var response = new MockHttpServletResponse();
        new AuthHttpBoundary(policy, false).doFilter(duplicate, response, (a, b) -> fail("Duplicate origin bypass"));
        assertThat(response.getStatus()).isEqualTo(403);
    }
    private static MockHttpServletRequest navigation(String method, String path, String mode, String destination) {
        var request = new MockHttpServletRequest(method, path); request.setSecure(true);
        request.addHeader("Sec-Fetch-Site", "cross-site"); request.addHeader("Sec-Fetch-Mode", mode);
        request.addHeader("Sec-Fetch-Dest", destination); return request;
    }
    @Test void omittedForceLoginDefaultsToFalseWithoutChangingExplicitTrue() {
        var json = tools.jackson.databind.json.JsonMapper.builder().build();
        assertThat(json.readValue("{}", LoginController.Begin.class).forceLogin()).isFalse();
        assertThat(json.readValue("{\"forceLogin\":true}", LoginController.Begin.class).forceLogin()).isTrue();
    }
    @Test void beginBindsClientOriginRedirectAndPkce() {
        var mapper = mock(ClientRegistryMapper.class);
        when(mapper.findByClientId("web")).thenReturn(new ClientRegistryMapper.ClientRow("registered", "web", "account", "WEB"));
        when(mapper.redirects("registered")).thenReturn(List.of("https://product.example/callback"));
        var policy = new LoginClientPolicy(mapper, "https://auth.example");
        assertThat(policy.begin("web", "https://product.example/callback", Pkce.challenge("v".repeat(43)), "S256",
                TokenSecrets.generate(), Set.of("account"), false, "https://product.example").forceLogin()).isFalse();
        assertThatThrownBy(() -> policy.begin("web", "https://product.example/callback", Pkce.challenge("v".repeat(43)), "S256",
                TokenSecrets.generate(), Set.of("account"), false, "https://other.example")).hasMessage("ORIGIN_NOT_ALLOWED");
        assertThatThrownBy(() -> policy.begin("web", "https://product.example/callback ", Pkce.challenge("v".repeat(43)), "S256",
                TokenSecrets.generate(), Set.of("account"), false, null)).hasMessage("INVALID_CLIENT");
        assertThatThrownBy(() -> policy.begin("web", "https://product.example/callback", "v".repeat(43), "plain",
                TokenSecrets.generate(), Set.of("account"), false, null)).hasMessage("INVALID_REQUEST");
    }

    @Test void insecureRemoteTransportCannotBeEnabledByForwardedHeaders() throws Exception {
        var policy = new LoginClientPolicy(mock(ClientRegistryMapper.class), "http://localhost:8080");
        var request = new MockHttpServletRequest("POST", "/api/v1/auth/transactions");
        request.setRemoteAddr("198.51.100.9"); request.addHeader("X-Forwarded-Proto", "https");
        var response = new MockHttpServletResponse(); var ran = new AtomicBoolean();
        new AuthHttpBoundary(policy, false).doFilter(request, response, (a, b) -> ran.set(true));
        assertThat(response.getStatus()).isEqualTo(400); assertThat(ran).isFalse();
    }

    @Test void chunkedJsonBodyIsBoundedBeforeParsing() throws Exception {
        var policy = new LoginClientPolicy(mock(ClientRegistryMapper.class), "https://auth.example");
        var request = new MockHttpServletRequest("POST", "/api/v1/auth/transactions") {
            @Override public long getContentLengthLong() { return -1; }
        };
        request.setSecure(true); request.setContentType("application/json"); request.setContent(new byte[16385]);
        var response = new MockHttpServletResponse();
        new AuthHttpBoundary(policy, false).doFilter(request, response, (a, b) -> fail("Oversized request passed the guard"));
        assertThat(response.getStatus()).isEqualTo(413);
    }

    @Test void productionCookieIsHostOnlySecureHttpOnlyAndNotInJsonBody() {
        var coordinator = mock(LoginCoordinator.class); String token = TokenSecrets.generate(), cookie = TokenSecrets.generate();
        when(coordinator.completeConfirmed(token, "https://auth.example", null, token, true)).thenReturn(new LoginCoordinator.Finished(
                "https://product.example/callback?code=test", cookie, Instant.now().plusSeconds(3600)));
        var request = new MockHttpServletRequest(); request.setSecure(true); request.addHeader("Origin", "https://auth.example");
        request.setAttribute(AuthHttpBoundary.REQUEST_ID, UUID.randomUUID().toString());
        var response = new MockHttpServletResponse();
        var result = new LoginController(coordinator, Clock.systemUTC()).complete(token, new LoginController.Confirmation(token, true), request, response);
        assertThat(response.getHeader("Set-Cookie")).startsWith("__Host-auth_session=").contains("Secure", "HttpOnly", "SameSite=Lax", "Path=/").doesNotContain("Domain=");
        assertThat(tools.jackson.databind.json.JsonMapper.builder().build().writeValueAsString(result)).doesNotContain(cookie);
    }
}
