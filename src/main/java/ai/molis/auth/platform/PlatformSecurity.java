package ai.molis.auth.platform;

import org.springframework.beans.factory.annotation.Value;
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
@ConditionalOnProperty(name="auth.login.enabled",havingValue="true")
public class PlatformSecurity {
    @Bean @Order(16) SecurityFilterChain platformApiSecurity(HttpSecurity http,@Value("${auth.issuer}") String issuer)throws Exception{
        http.securityMatcher("/api/v1/platform/**").addFilterBefore(new PlatformBoundary(issuer),SecurityContextHolderFilter.class);
        http.csrf(AbstractHttpConfigurer::disable).formLogin(AbstractHttpConfigurer::disable).httpBasic(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable).requestCache(AbstractHttpConfigurer::disable)
                .sessionManagement(s->s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        // Every mapped controller method invokes the same transactional whitelist guard; cookies are never credentials.
        http.authorizeHttpRequests(r->r
                .requestMatchers(HttpMethod.GET,"/api/v1/platform/me","/api/v1/platform/mail","/api/v1/platform/permission-catalog",
                        "/api/v1/platform/applications","/api/v1/platform/applications/{app}","/api/v1/platform/applications/{app}/permission-matrix",
                        "/api/v1/platform/applications/{app}/clients","/api/v1/platform/applications/{app}/services",
                        "/api/v1/platform/clients/{client}","/api/v1/platform/users","/api/v1/platform/users/{user}","/api/v1/platform/audit").permitAll()
                .requestMatchers(HttpMethod.POST,"/api/v1/platform/mail/{mail}/resend","/api/v1/platform/applications","/api/v1/platform/applications/{app}/clients",
                        "/api/v1/platform/applications/{app}/services","/api/v1/platform/services/{client}/rotate","/api/v1/platform/services/{client}/disable").permitAll()
                .requestMatchers(HttpMethod.PUT,"/api/v1/platform/applications/{app}/permission-matrix","/api/v1/platform/applications/{app}","/api/v1/platform/clients/{client}","/api/v1/platform/users/{user}/status").permitAll()
                .anyRequest().denyAll());return http.build();
    }
}
