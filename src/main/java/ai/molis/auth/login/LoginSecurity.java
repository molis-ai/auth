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

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "auth.login.enabled", havingValue = "true")
public class LoginSecurity {
    @Bean @Order(20) SecurityFilterChain loginApiFilterChain(HttpSecurity http, LoginClientPolicy policy) throws Exception {
        http.securityMatcher("/api/v1/auth/**", "/oauth2/token", "/api/v1/users/me", "/api/v1/users/me/profile", "/api/v1/sessions/**");
        http.addFilterBefore(new AuthHttpBoundary(policy, false), SecurityContextHolderFilter.class);
        // JSON + transaction header + exact Origin checks replace ambient-cookie CSRF for these endpoints only.
        http.csrf(AbstractHttpConfigurer::disable);
        http.authorizeHttpRequests(auth -> auth
                .requestMatchers(HttpMethod.OPTIONS, "/api/v1/auth/**", "/oauth2/token", "/api/v1/users/me", "/api/v1/users/me/profile", "/api/v1/sessions/**").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/v1/users/me/profile").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/v1/users/me", "/api/v1/sessions/authentications", "/api/v1/sessions/security-events", "/api/v1/sessions/login-methods").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/v1/sessions/current/logout", "/api/v1/sessions/logout-all", "/api/v1/sessions/authentications/{id}/revoke", "/api/v1/sessions/login-methods/{id}/unlink").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/v1/auth/transactions/context", "/api/v1/auth/ui-configuration").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/v1/auth/transactions", "/api/v1/auth/transactions/password",
                        "/api/v1/auth/transactions/restore", "/api/v1/auth/transactions/complete", "/api/v1/auth/transactions/confirmation", "/api/v1/auth/transactions/cancel",
                        "/api/v1/auth/transactions/mailbox", "/api/v1/auth/mailbox/verify",
                        "/api/v1/auth/transactions/signup", "/api/v1/auth/transactions/register", "/api/v1/auth/transactions/reset-password").permitAll()
                .anyRequest().denyAll());
        http.formLogin(AbstractHttpConfigurer::disable).httpBasic(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable).requestCache(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
