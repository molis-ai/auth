package ai.molis.auth.space;

import ai.molis.auth.login.LoginClientPolicy;
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
public class SpaceSecurity {
    @Bean @Order(17) SecurityFilterChain spaceApiSecurity(HttpSecurity http,LoginClientPolicy policy)throws Exception{
        http.securityMatcher("/api/v1/spaces","/api/v1/spaces/**","/api/v1/invitations","/api/v1/invitations/**")
                .addFilterBefore(new SpaceBoundary(policy),SecurityContextHolderFilter.class);
        http.csrf(AbstractHttpConfigurer::disable).formLogin(AbstractHttpConfigurer::disable).httpBasic(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable).requestCache(AbstractHttpConfigurer::disable)
                .sessionManagement(s->s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        http.authorizeHttpRequests(r->r.requestMatchers(HttpMethod.OPTIONS,"/api/v1/spaces","/api/v1/spaces/**","/api/v1/invitations","/api/v1/invitations/**").permitAll()
                .requestMatchers(HttpMethod.GET,"/api/v1/spaces","/api/v1/spaces/{space}","/api/v1/spaces/{space}/members","/api/v1/spaces/{space}/invitations","/api/v1/spaces/{space}/audit","/api/v1/invitations","/api/v1/invitations/{id}").permitAll()
                .requestMatchers(HttpMethod.POST,"/api/v1/spaces","/api/v1/spaces/{space}/invite-candidates","/api/v1/spaces/{space}/members/{user}/remove","/api/v1/spaces/{space}/leave","/api/v1/spaces/{space}/invitations","/api/v1/spaces/{space}/invitations/{id}/revoke","/api/v1/invitations/{id}/accept","/api/v1/invitations/{id}/decline").permitAll()
                .requestMatchers(HttpMethod.PUT,"/api/v1/spaces/{space}","/api/v1/spaces/{space}/archive","/api/v1/spaces/{space}/members/{user}/role").permitAll().anyRequest().denyAll());
        return http.build();
    }
}
