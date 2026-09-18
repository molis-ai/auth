package ai.molis.example.auth;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter;

@Configuration(proxyBeanMethods=false)
public class DemoSecurity {
    @Bean SecurityFilterChain demoFilterChain(HttpSecurity http,@Value("${demo.allow-loopback-http:false}") boolean local)throws Exception{
        http.csrf(c->c.disable()).requestCache(c->c.disable()).sessionManagement(c->c.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .formLogin(c->c.disable()).httpBasic(c->c.disable()).logout(c->c.disable());
        http.addFilterBefore(new DemoBoundary(local),AnonymousAuthenticationFilter.class);
        // Transport/token syntax here; current authorization is enforced by ProjectService for each operation.
        http.authorizeHttpRequests(a->a.requestMatchers(HttpMethod.GET,"/demo/projects","/demo/projects/{id}","/demo/projects/{id}/actions").permitAll()
            .requestMatchers(HttpMethod.PUT,"/demo/projects/{id}").permitAll().anyRequest().denyAll());return http.build();
    }
}
