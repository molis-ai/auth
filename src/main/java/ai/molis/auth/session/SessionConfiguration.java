package ai.molis.auth.session;

import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class SessionConfiguration {
    @Bean
    Clock authClock() { return Clock.systemUTC(); }
}
