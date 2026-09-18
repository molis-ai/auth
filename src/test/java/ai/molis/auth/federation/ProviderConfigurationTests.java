package ai.molis.auth.federation;

import ai.molis.auth.login.*;
import ai.molis.auth.verification.RedisRateLimiter;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.time.Clock;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.data.redis.core.StringRedisTemplate;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class ProviderConfigurationTests {
    @Test void defaultOffCreatesNoProviderClientsOrCipher() {
        new ApplicationContextRunner().withUserConfiguration(ProviderConfiguration.class).run(context->{
            assertThat(context).hasNotFailed().doesNotHaveBean(ProviderConfiguration.ProviderClients.class).doesNotHaveBean(ProviderStateCipher.class);
        });
    }
    @Test void explicitConfigurationBindsBuildsAndKeepsSecretsOutOfDiagnostics() {
        runner().withPropertyValues("auth.federation.google.enabled=true","auth.federation.google.client-id=test-client","auth.federation.google.client-secret=deployment-secret").run(context->{
            assertThat(context).hasNotFailed().hasSingleBean(ProviderLoginCoordinator.class);
            var settings=context.getBean(ProviderConfiguration.Settings.class);
            assertThat(settings.toString()+settings.google()+settings.crypto()).doesNotContain("deployment-secret",ProviderStateTests.testKey(1));
            var clients=context.getBean(ProviderConfiguration.ProviderClients.class).values();
            assertThat(clients).hasSize(1);
            assertThat(clients.getFirst().registration().callback().toASCIIString()).isEqualTo("https://auth.example.test/oauth2/callback/google");
        });
    }
    @Test void missingSecretsBadKeysNoProviderAndMissingPrerequisitesFailStartup() {
        runner().run(context->assertThat(context).hasFailed());
        runner().withPropertyValues("auth.federation.google.enabled=true","auth.federation.google.client-id=test-client").run(context->assertThat(context).hasFailed());
        runner().withPropertyValues("auth.federation.google.enabled=true","auth.federation.google.client-id=test-client","auth.federation.google.client-secret=test-secret","auth.federation.crypto.keys.primary=bad-key").run(context->assertThat(context).hasFailed());
        runner().withPropertyValues("auth.login.enabled=false").run(context->assertThat(context).hasFailed());
    }
    @Test void applePkcs8KeyIsValidatedAndNonHttpsOrBadSecretHasSafeErrors() throws Exception {
        var generator=KeyPairGenerator.getInstance("EC");generator.initialize(new ECGenParameterSpec("secp256r1"));
        String key=Base64.getEncoder().encodeToString(generator.generateKeyPair().getPrivate().getEncoded());
        var apple=new ProviderConfiguration.Apple(true,"test-client","ABCDEFGHIJ","KLMNOPQRST",key);
        assertThat(ProviderConfiguration.appleKey(apple).privateKey().getParams().getCurve().getField().getFieldSize()).isEqualTo(256);
        var settings=new ProviderConfiguration.Settings(true,null,apple,null);
        try(var clients=ProviderConfiguration.configured(settings,"https://auth.example.test",Clock.systemUTC())){assertThat(clients.values()).hasSize(1);}
        for(String origin:List.of("http://localhost:8080","https://auth.example.test/path","https://auth.example.test/"))
            assertThatThrownBy(()->ProviderConfiguration.configured(settings,origin,Clock.systemUTC())).hasMessage("Invalid provider deployment configuration").hasNoCause();
        assertThatThrownBy(()->ProviderConfiguration.appleKey(new ProviderConfiguration.Apple(true,"test-client","ABCDEFGHIJ","KLMNOPQRST","private-key-not-valid")))
                .hasMessage("Invalid Apple signing configuration").hasNoCause();
    }
    private ApplicationContextRunner runner() {
        var policy=mock(LoginClientPolicy.class);when(policy.authOrigin()).thenReturn("https://auth.example.test");
        return new ApplicationContextRunner().withUserConfiguration(ProviderConfiguration.class)
                .withBean(Clock.class,Clock::systemUTC).withBean(StringRedisTemplate.class,()->mock(StringRedisTemplate.class))
                .withBean(ai.molis.auth.verification.RedisMailboxProofs.class,()->mock(ai.molis.auth.verification.RedisMailboxProofs.class))
                .withBean(RedisAuthTransactions.class,()->mock(RedisAuthTransactions.class)).withBean(LoginClientPolicy.class,()->policy)
                .withBean(RedisRateLimiter.class,()->mock(RedisRateLimiter.class)).withBean(ExternalAccountService.class,()->mock(ExternalAccountService.class))
                .withPropertyValues("auth.federation.enabled=true","auth.login.enabled=true","auth.ephemeral.enabled=true","auth.issuer=https://auth.example.test",
                        "auth.federation.crypto.active-key-id=primary","auth.federation.crypto.keys.primary="+ProviderStateTests.testKey(1));
    }
}
