package ai.molis.example.auth;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication(exclude=org.springframework.boot.security.autoconfigure.UserDetailsServiceAutoConfiguration.class)
public class DemoApplication {
    public static void main(String[] args){var app=new SpringApplication(DemoApplication.class);app.setDefaultProperties(java.util.Map.of("spring.config.name","demo"));app.run(args);}
}
