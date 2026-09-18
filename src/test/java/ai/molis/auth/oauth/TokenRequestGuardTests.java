package ai.molis.auth.oauth;

import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import static org.assertj.core.api.Assertions.*;

class TokenRequestGuardTests {
    @Test
    void productionRequiresHttpsEvenFromLoopback() throws Exception {
        var request = request();
        assertThat(allowed(false, request)).isFalse();
        request.setSecure(true);
        assertThat(allowed(false, request)).isTrue();
    }

    @Test
    void developmentHttpIsLimitedToActualLoopbackNotForwardedHeaders() throws Exception {
        var request = request();
        assertThat(allowed(true, request)).isTrue();
        request.setRemoteAddr("203.0.113.1");
        request.addHeader("Host", "localhost");
        request.addHeader("X-Forwarded-For", "127.0.0.1");
        assertThat(allowed(true, request)).isFalse();
    }

    @Test
    void duplicateParametersAndQuerySecretsNeverReachAuthentication() throws Exception {
        var duplicate = request();
        duplicate.addParameter("grant_type", "authorization_code", "refresh_token");
        assertThat(allowed(true, duplicate)).isFalse();
        var query = request();
        query.setQueryString("refresh_token=not-a-real-token");
        assertThat(allowed(true, query)).isFalse();
    }

    @Test
    void rejectsUnsupportedPayloadsDpopAndOversizedBodies() throws Exception {
        var json = request();
        json.setContentType("application/json");
        assertThat(allowed(true, json)).isFalse();
        var wildcard = request();
        wildcard.setContentType("application/*");
        assertThat(allowed(true, wildcard)).isFalse();
        var dpop = request();
        dpop.addHeader("DPoP", "unsupported");
        assertThat(allowed(true, dpop)).isFalse();
        var oversized = request();
        oversized.setContent(new byte[17000]);
        assertThat(allowed(true, oversized)).isFalse();
    }

    @Test
    void issuerRejectsRemotePlaintextAndAmbiguousUrls() {
        var configuration = new OAuthTokenEndpointConfiguration();
        assertThat(configuration.authorizationServerSettings("https://auth.example").getIssuer())
                .isEqualTo("https://auth.example");
        assertThat(configuration.authorizationServerSettings("http://localhost:8080")).isNotNull();
        for (var invalid : new String[] {"http://auth.example", "https://user@auth.example",
                "https://auth.example?query", "https://auth.example#fragment", "/relative"}) {
            assertThatIllegalArgumentException().isThrownBy(() -> configuration.authorizationServerSettings(invalid));
        }
    }

    private static MockHttpServletRequest request() {
        var request = new MockHttpServletRequest("POST", "/oauth2/token");
        request.setRemoteAddr("127.0.0.1");
        request.setContentType("application/x-www-form-urlencoded");
        return request;
    }

    private static boolean allowed(boolean development, MockHttpServletRequest request) throws Exception {
        var response = new MockHttpServletResponse();
        var reached = new AtomicBoolean();
        new TokenRequestGuard(development).doFilter(request, response, (ignoredRequest, ignoredResponse) -> reached.set(true));
        if (!reached.get()) {
            assertThat(response.getStatus()).isEqualTo(400);
            assertThat(response.getContentAsString()).contains("invalid_request");
        }
        return reached.get();
    }
}
