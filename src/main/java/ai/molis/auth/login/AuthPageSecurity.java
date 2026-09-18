package ai.molis.auth.login;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.SecurityContextHolderFilter;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "auth.login.enabled", havingValue = "true")
public class AuthPageSecurity {
    @Bean @Order(30) SecurityFilterChain authPagesFilterChain(HttpSecurity http, LoginClientPolicy policy) throws Exception {
        http.securityMatcher("/", "/login", "/provider", "/provider-mailbox", "/register", "/forgot-password", "/complete", "/verify-email", "/console", "/console/callback", "/auth-ui/**");
        http.addFilterBefore(new AuthHttpBoundary(policy, false), SecurityContextHolderFilter.class);
        http.authorizeHttpRequests(auth -> auth.requestMatchers(HttpMethod.GET, "/", "/login", "/provider", "/provider-mailbox", "/register",
                "/forgot-password", "/complete", "/verify-email", "/console", "/console/callback", "/auth-ui/**").permitAll().anyRequest().denyAll());
        http.headers(headers -> headers
                .contentSecurityPolicy(csp -> csp.policyDirectives("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"))
                .referrerPolicy(referrer -> referrer.policy(ReferrerPolicy.NO_REFERRER)));
        http.csrf(AbstractHttpConfigurer::disable).formLogin(AbstractHttpConfigurer::disable).httpBasic(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable).requestCache(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
