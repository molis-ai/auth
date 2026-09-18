package ai.molis.auth.authorization;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.SecurityContextHolderFilter;

@Configuration(proxyBeanMethods=false)
public class AuthorizationSecurity {
    @Bean @Order(15) SecurityFilterChain authorizationApiSecurity(HttpSecurity http,@Value("${auth.issuer:http://localhost:8080}") String issuer)throws Exception{
        http.securityMatcher("/api/v1/authorization/**");
        http.addFilterBefore(new AuthorizationBoundary(issuer),SecurityContextHolderFilter.class);
        http.csrf(AbstractHttpConfigurer::disable).formLogin(AbstractHttpConfigurer::disable).httpBasic(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable).requestCache(AbstractHttpConfigurer::disable)
                .sessionManagement(session->session.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        // Controller executes the two-identity transactional authorizer; no path bypasses it.
        http.authorizeHttpRequests(requests->requests.requestMatchers(HttpMethod.POST,"/api/v1/authorization/check",
                "/api/v1/authorization/allowed-actions","/api/v1/authorization/spaces","/api/v1/authorization/activity").permitAll().anyRequest().denyAll());
        return http.build();
    }
}
