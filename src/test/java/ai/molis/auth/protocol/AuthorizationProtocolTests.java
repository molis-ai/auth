package ai.molis.auth.protocol;

import ai.molis.auth.security.TokenSecrets;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Principal;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.RepeatedTest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.oauth2.server.authorization.OAuth2AuthorizationServerConfigurer;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;
import org.springframework.security.oauth2.server.authorization.*;
import org.springframework.security.oauth2.server.authorization.authentication.*;
import org.springframework.security.oauth2.server.authorization.client.*;
import org.springframework.security.oauth2.server.authorization.settings.*;
import org.springframework.security.oauth2.server.authorization.token.*;
import org.springframework.security.oauth2.server.authorization.web.authentication.OAuth2ErrorAuthenticationFailureHandler;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.test.context.junit.jupiter.web.SpringJUnitWebConfig;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.web.context.WebApplicationContext;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers.springSecurity;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.springframework.test.web.servlet.setup.MockMvcBuilders.webAppContextSetup;

/**
 * Real Spring Security HTTP token endpoint; identity verification is deliberately seeded.
 * This proves protocol adaptation, not registration, browser login or MySQL correctness.
 */
@SpringJUnitWebConfig(AuthorizationProtocolTests.Config.class)
class AuthorizationProtocolTests {
    private static final String REDIRECT = "https://product.example/callback";
    private static final String VERIFIER = "abcdefghijklmnopqrstuvwxyz0123456789-._~ABCDEFGHIJK";
    @Autowired WebApplicationContext context;
    @Autowired HashOnlyAuthorizationFixture store;
    @Autowired RegisteredClientRepository clients;
    private MockMvc mvc;

    @BeforeEach
    void setup() {
        store.clear();
        mvc = webAppContextSetup(context).apply(springSecurity()).build();
    }

    @Test
    void officialGeneratorDoesNotIssueRefreshForPublicAuthorizationCode() {
        var client = clients.findByClientId("web");
        var publicPrincipal = new OAuth2ClientAuthenticationToken(client, ClientAuthenticationMethod.NONE, null);
        var grant = new OAuth2AuthorizationCodeAuthenticationToken("unused", publicPrincipal, REDIRECT, Map.of());
        var tokenContext = DefaultOAuth2TokenContext.builder().registeredClient(client)
                .principal(UsernamePasswordAuthenticationToken.authenticated("user-1", null, List.of()))
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .authorizationGrant(grant).tokenType(OAuth2TokenType.REFRESH_TOKEN).build();
        assertThat(new OAuth2RefreshTokenGenerator().generate(tokenContext)).isNull();
    }

    @Test
    void pkceExchangeReturnsOpaqueTokensAndOnlyHashesAreStored() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        var result = exchange(code, "web", VERIFIER, REDIRECT)
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")))
                .andExpect(jsonPath("$.token_type").value("Bearer"))
                .andExpect(jsonPath("$.expires_in").value(org.hamcrest.Matchers.greaterThanOrEqualTo(899)))
                .andReturn();
        String access = field(result.getResponse().getContentAsString(), "access_token");
        String refresh = field(result.getResponse().getContentAsString(), "refresh_token");
        assertThat(access).doesNotContain(".");
        assertThat(refresh).matches("[A-Za-z0-9_-]{43}");
        var saved = store.findById(code.id());
        assertThat(saved.getAccessToken().getToken().getTokenValue()).isEqualTo(TokenSecrets.digest(access));
        assertThat(saved.getRefreshToken().getToken().getTokenValue()).isEqualTo(TokenSecrets.digest(refresh));
        assertThat(saved.getToken(OAuth2AuthorizationCode.class).getToken().getTokenValue())
                .isEqualTo(TokenSecrets.digest(code.value()));
        assertThat(store.findByToken(TokenSecrets.digest(access), OAuth2TokenType.ACCESS_TOKEN)).isNull();
    }

    @Test
    void wrongVerifierCannotConsumeCode() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        exchange(code, "web", "x".repeat(43), REDIRECT).andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
        exchange(code, "web", VERIFIER, REDIRECT).andExpect(status().isOk());
    }

    @Test
    void missingVerifierAndPlainChallengeAreRejected() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        mvc.perform(post("/oauth2/token").param("grant_type", "authorization_code")
                .param("client_id", "web").param("code", code.value()).param("redirect_uri", REDIRECT))
                .andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
        var plain = seed("web", "plain", Instant.now().plusSeconds(60));
        exchange(plain, "web", VERIFIER, REDIRECT).andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
    }

    @Test
    void redirectMustMatchExactly() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        exchange(code, "web", VERIFIER, REDIRECT + "/other").andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
        exchange(code, "web", VERIFIER, REDIRECT).andExpect(status().isOk());
    }

    @Test
    void anotherPublicClientCannotRedeemCode() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        exchange(code, "mac", VERIFIER, REDIRECT).andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
        assertThat(store.findById(code.id()).getAccessToken()).isNull();
    }

    @Test
    void expiredCodeIsRejected() throws Exception {
        var code = seed("web", "S256", Instant.now().minusSeconds(1));
        exchange(code, "web", VERIFIER, REDIRECT).andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
    }

    @Test
    void codeReplayRevokesIssuedTokens() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        exchange(code, "web", VERIFIER, REDIRECT).andExpect(status().isOk());
        exchange(code, "web", VERIFIER, REDIRECT).andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
        assertThat(store.findById(code.id()).getAccessToken().isActive()).isFalse();
        assertThat(store.findById(code.id()).getRefreshToken().isActive()).isFalse();
    }

    @Test
    void refreshRotatesAndReplayRevokesTheCurrentFamily() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        String first = firstRefresh(code);
        String second = field(refresh(first, "web").andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(), "refresh_token");
        assertThat(second).isNotEqualTo(first);
        assertThat(store.findById(code.id()).getRefreshToken().getToken().getTokenValue())
                .isEqualTo(TokenSecrets.digest(second));
        refresh(first, "web").andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
        refresh(second, "web").andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
        assertThat(store.findById(code.id()).getAccessToken().isActive()).isFalse();
    }

    @Test
    void wrongClientCannotRefreshOrRevokeVictimFamily() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        String token = firstRefresh(code);
        refresh(token, "mac").andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
        assertThat(store.findById(code.id()).getRefreshToken().isActive()).isTrue();
        refresh(token, "web").andExpect(status().isOk());
    }

    @Test
    void expiredRefreshIsRejected() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        String token = firstRefresh(code);
        var row = store.findByToken(token, OAuth2TokenType.REFRESH_TOKEN);
        store.save(OAuth2Authorization.from(row).refreshToken(new OAuth2RefreshToken(token,
                Instant.now().minusSeconds(100), Instant.now().minusSeconds(1))).build());
        refresh(token, "web").andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
    }

    @Test
    void unknownOrDuplicatedRefreshParametersAreRejected() throws Exception {
        refresh(TokenSecrets.generate(), "web").andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        String token = firstRefresh(code);
        mvc.perform(post("/oauth2/token").param("grant_type", "refresh_token")
                .param("client_id", "web", "mac").param("refresh_token", token))
                .andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
        refresh(token, "web").andExpect(status().isOk());
    }

    @Test
    void publicClientCannotUseClientCredentialsGrant() throws Exception {
        mvc.perform(post("/oauth2/token").param("grant_type", "client_credentials").param("client_id", "web"))
                .andExpect(status().is4xxClientError()).andExpect(jsonPath("$.error").isString());
    }

    @Test
    void refreshCannotExpandScopes() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        String token = firstRefresh(code);
        mvc.perform(post("/oauth2/token").param("grant_type", "refresh_token").param("client_id", "web")
                .param("refresh_token", token).param("scope", "admin"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").value("invalid_scope"));
        refresh(token, "web").andExpect(status().isOk());
    }

    @RepeatedTest(10)
    void concurrentRefreshOnlyOneSucceedsAndReuseRevokesFamily() throws Exception {
        var code = seed("web", "S256", Instant.now().plusSeconds(60));
        String token = firstRefresh(code);
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> {
                start.await();
                return refresh(token, "web").andReturn().getResponse().getStatus();
            });
            var second = executor.submit(() -> {
                start.await();
                return refresh(token, "web").andReturn().getResponse().getStatus();
            });
            start.countDown();
            assertThat(List.of(first.get(10, java.util.concurrent.TimeUnit.SECONDS), second.get(10, java.util.concurrent.TimeUnit.SECONDS))).containsExactlyInAnyOrder(200, 400);
        }
        assertThat(store.findById(code.id()).getRefreshToken().isActive()).isFalse();
    }

    private String firstRefresh(Code code) throws Exception {
        return field(exchange(code, "web", VERIFIER, REDIRECT).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(), "refresh_token");
    }

    private ResultActions exchange(Code code, String client, String verifier, String redirect) throws Exception {
        return mvc.perform(post("/oauth2/token").param("grant_type", "authorization_code")
                .param("client_id", client).param("code", code.value())
                .param("redirect_uri", redirect).param("code_verifier", verifier));
    }

    private ResultActions refresh(String token, String client) throws Exception {
        return mvc.perform(post("/oauth2/token").param("grant_type", "refresh_token")
                .param("client_id", client).param("refresh_token", token));
    }

    private static String field(String json, String name) {
        return JsonMapper.builder().build().readTree(json).get(name).asText();
    }

    private Code seed(String clientId, String method, Instant expiresAt) throws Exception {
        var client = clients.findByClientId(clientId);
        String challenge = method.equals("S256") ? Base64.getUrlEncoder().withoutPadding()
                .encodeToString(MessageDigest.getInstance("SHA-256").digest(VERIFIER.getBytes(StandardCharsets.US_ASCII)))
                : VERIFIER;
        var request = OAuth2AuthorizationRequest.authorizationCode().authorizationUri("https://auth.example/oauth2/authorize")
                .clientId(clientId).redirectUri(REDIRECT).scopes(Set.of("account"))
                .additionalParameters(Map.of("code_challenge", challenge, "code_challenge_method", method)).build();
        String value = TokenSecrets.generate();
        var authorization = OAuth2Authorization.withRegisteredClient(client).principalName("user-1")
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE).authorizedScopes(Set.of("account"))
                .attribute(Principal.class.getName(),
                        UsernamePasswordAuthenticationToken.authenticated("user-1", null, List.of()))
                .attribute(OAuth2AuthorizationRequest.class.getName(), request)
                .token(new OAuth2AuthorizationCode(value, Instant.now().minusSeconds(60), expiresAt)).build();
        store.save(authorization);
        return new Code(authorization.getId(), value);
    }

    private record Code(String id, String value) {}

    @Configuration(proxyBeanMethods = false)
    @EnableWebSecurity
    static class Config {
        @Bean HashOnlyAuthorizationFixture store() { return new HashOnlyAuthorizationFixture(); }

        @Bean RegisteredClientRepository clients() {
            return new InMemoryRegisteredClientRepository(client("web"), client("mac"));
        }

        private static RegisteredClient client(String id) {
            return RegisteredClient.withId("registered-" + id).clientId(id)
                    .clientAuthenticationMethod(ClientAuthenticationMethod.NONE)
                    .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                    .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
                    .redirectUri(REDIRECT).scope("account")
                    .clientSettings(ClientSettings.builder().requireProofKey(true).build())
                    .tokenSettings(TokenSettings.builder().accessTokenFormat(OAuth2TokenFormat.REFERENCE)
                            .accessTokenTimeToLive(Duration.ofMinutes(15))
                            .refreshTokenTimeToLive(Duration.ofDays(30)).reuseRefreshTokens(false).build()).build();
        }

        @Bean SecurityFilterChain security(HttpSecurity http, HashOnlyAuthorizationFixture store,
                RegisteredClientRepository clients) throws Exception {
            var generator = new DelegatingOAuth2TokenGenerator(new OAuth2AccessTokenGenerator(),
                    PublicRefreshFixture.refreshGenerator());
            var publicRefresh = new PublicRefreshFixture(clients, store);
            var server = new OAuth2AuthorizationServerConfigurer();
            http.with(server, config -> config.registeredClientRepository(clients).authorizationService(store)
                    .authorizationServerSettings(AuthorizationServerSettings.builder().issuer("https://auth.example").build())
                    .tokenGenerator(generator)
                    .clientAuthentication(client -> client.authenticationConverter(publicRefresh)
                            .authenticationProvider(publicRefresh))
                    .tokenEndpoint(token -> token.authenticationProviders(providers -> providers.replaceAll(provider ->
                            provider instanceof OAuth2AuthorizationCodeAuthenticationProvider
                                    || provider instanceof OAuth2RefreshTokenAuthenticationProvider
                                    ? PublicRefreshFixture.atomic(provider, store) : provider))));
            http.csrf(csrf -> csrf.ignoringRequestMatchers(server.getEndpointsMatcher()));
            http.exceptionHandling(errors -> errors.authenticationEntryPoint((request, response, error) ->
                    new OAuth2ErrorAuthenticationFailureHandler().onAuthenticationFailure(request, response,
                            new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_CLIENT))));
            http.authorizeHttpRequests(requests -> requests
                    .requestMatchers(server.getEndpointsMatcher()).authenticated().anyRequest().denyAll());
            return http.build();
        }
    }
}
