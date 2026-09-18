package ai.molis.auth.oauth;

import ai.molis.auth.session.SessionService;
import java.net.URI;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.annotation.web.configurers.oauth2.server.authorization.OAuth2AuthorizationServerConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.server.authorization.OAuth2AuthorizationService;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClientRepository;
import org.springframework.security.oauth2.server.authorization.settings.AuthorizationServerSettings;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.SecurityContextHolderFilter;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;

@Configuration(proxyBeanMethods = false)
public class OAuthTokenEndpointConfiguration {
    @Bean
    AuthorizationServerSettings authorizationServerSettings(@Value("${auth.issuer:http://localhost:8080}") String issuer) {
        URI uri = URI.create(issuer);
        if (uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null || uri.getQuery() != null
                || !("https".equals(uri.getScheme()) || localIssuer(uri))) {
            throw new IllegalArgumentException("Auth issuer must use HTTPS, except loopback development");
        }
        return AuthorizationServerSettings.builder().issuer(issuer).build();
    }

    @Bean @Order(10)
    SecurityFilterChain tokenSecurity(HttpSecurity http, RegisteredClientRepository clients,
            OAuth2AuthorizationService authorizations, AuthorizationServerSettings settings, SessionService sessions,
            ai.molis.auth.service.ServiceIdentityService services,
            org.springframework.beans.factory.ObjectProvider<ai.molis.auth.login.LoginClientPolicy> loginPolicy,
            org.springframework.beans.factory.ObjectProvider<ai.molis.auth.verification.RedisRateLimiter> limiter)
            throws Exception {
        var errors = new ProtocolErrors(services);
        var publicRefresh = new PublicRefreshAuthentication(clients);
        var serviceClient = new ServiceClientAuthentication(services,limiter);
        var tokenRequest = PathPatternRequestMatcher.withDefaults().matcher(HttpMethod.POST, "/oauth2/token");
        http.securityMatcher(tokenRequest);
        http.with(new OAuth2AuthorizationServerConfigurer(), server -> server
                .registeredClientRepository(clients).authorizationService(authorizations)
                .authorizationServerSettings(settings)
                .clientAuthentication(client -> client.authenticationConverter(publicRefresh)
                        .authenticationProvider(publicRefresh)
                        .authenticationConverters(converters -> converters.add(0,serviceClient))
                        .authenticationProviders(providers -> providers.add(0,serviceClient)).errorResponseHandler(errors))
                .tokenEndpoint(token -> token.authenticationProviders(providers -> {
                    providers.clear();
                    providers.add(new DurableGrantAuthenticationProvider(sessions));
                    providers.add(new ServiceGrantAuthenticationProvider(services));
                }).errorResponseHandler(errors)));
        http.addFilterBefore(new TokenRequestGuard(localIssuer(URI.create(settings.getIssuer())),errors), SecurityContextHolderFilter.class);
        var browserPolicy = loginPolicy.getIfAvailable();
        if (browserPolicy != null) http.addFilterBefore(new ai.molis.auth.login.AuthHttpBoundary(browserPolicy, true), SecurityContextHolderFilter.class);
        http.csrf(csrf -> csrf.ignoringRequestMatchers(tokenRequest));
        http.authorizeHttpRequests(requests -> requests.anyRequest().authenticated());
        http.exceptionHandling(exceptions -> exceptions.authenticationEntryPoint((request, response, failure) ->
                errors.onAuthenticationFailure(request, response, new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_CLIENT))));
        http.requestCache(AbstractHttpConfigurer::disable);
        http.sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }

    private static boolean localIssuer(URI uri) {
        return "http".equals(uri.getScheme()) && uri.getHost() != null
                && Set.of("localhost", "127.0.0.1", "[::1]", "::1").contains(uri.getHost());
    }
}
