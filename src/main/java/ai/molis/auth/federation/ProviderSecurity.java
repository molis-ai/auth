package ai.molis.auth.federation;

import ai.molis.auth.login.LoginClientPolicy;
import ai.molis.auth.verification.RedisRateLimiter;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.SecurityContextHolderFilter;

@Configuration(proxyBeanMethods=false)
@ConditionalOnProperty(name="auth.federation.enabled",havingValue="true")
public class ProviderSecurity {
    @Bean @Order(15) SecurityFilterChain providerFilterChain(HttpSecurity http,LoginClientPolicy policy,RedisRateLimiter limiter) throws Exception {
        http.securityMatcher("/api/v1/auth/providers/**","/oauth2/callback/**");
        http.addFilterBefore(new ProviderHttpBoundary(policy,limiter),SecurityContextHolderFilter.class);
        // Only this fixed OAuth surface replaces synchronizer CSRF with state + independent browser binding.
        http.csrf(AbstractHttpConfigurer::disable);
        http.authorizeHttpRequests(auth->auth.requestMatchers(HttpMethod.POST,"/api/v1/auth/providers/google/start","/api/v1/auth/providers/apple/start","/api/v1/auth/providers/google/bind","/api/v1/auth/providers/apple/bind","/oauth2/callback/apple").permitAll()
                .requestMatchers(HttpMethod.POST,"/api/v1/auth/providers/continuation/context","/api/v1/auth/providers/continuation/mailbox","/api/v1/auth/providers/continuation/complete","/api/v1/auth/providers/continuation/cancel","/api/v1/auth/providers/continuation/link-password").permitAll()
                .requestMatchers(HttpMethod.POST,"/api/v1/auth/providers/continuation/reauthenticate").permitAll()
                .requestMatchers(HttpMethod.GET,"/oauth2/callback/google").permitAll().anyRequest().denyAll());
        http.formLogin(AbstractHttpConfigurer::disable).httpBasic(AbstractHttpConfigurer::disable).logout(AbstractHttpConfigurer::disable)
                .requestCache(AbstractHttpConfigurer::disable).sessionManagement(session->session.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
