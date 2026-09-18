package ai.molis.auth.federation;

import ai.molis.auth.login.*;
import ai.molis.auth.verification.RedisRateLimiter;
import java.net.URI;
import java.security.KeyFactory;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Clock;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.core.StringRedisTemplate;

/** Deployment-only immutable V1 configuration; changes require a coordinated restart. No discovery overrides. */
@Configuration(proxyBeanMethods=false)
@ConditionalOnProperty(name="auth.federation.enabled", havingValue="true")
@EnableConfigurationProperties(ProviderConfiguration.Settings.class)
public class ProviderConfiguration {
    @Bean ProviderClients providerClients(Settings settings, Clock clock, @Value("${auth.issuer}") String issuer,
            @Value("${auth.login.enabled:false}") boolean login, @Value("${auth.ephemeral.enabled:false}") boolean ephemeral) {
        if (!login || !ephemeral) throw new IllegalArgumentException("Federation requires login and ephemeral stores");
        return configured(settings, issuer, clock);
    }
    @Bean ProviderStateCipher providerStateCipher(Settings settings) {
        if (settings.crypto()==null) throw new IllegalArgumentException("Provider state keys required");
        return new ProviderStateCipher(settings.crypto().activeKeyId(),settings.crypto().keys());
    }
    @Bean RedisProviderTransactions redisProviderTransactions(StringRedisTemplate redis, ProviderStateCipher cipher, Clock clock) {
        return new RedisProviderTransactions(redis,cipher,clock);
    }
    @Bean ProviderLoginCoordinator providerLoginCoordinator(ProviderClients clients, RedisProviderTransactions states,
            RedisAuthTransactions auth, LoginClientPolicy policy, RedisRateLimiter limiter, ExternalAccountService accounts,
            org.springframework.beans.factory.ObjectProvider<ProviderMailboxContinuation> continuation) {
        return new ProviderLoginCoordinator(clients.values(),states,auth,policy,limiter,accounts,continuation.getIfAvailable());
    }
    @Bean
    ProviderMailboxContinuation providerMailboxContinuation(StringRedisTemplate redis,ProviderStateCipher cipher,Clock clock,
            RedisAuthTransactions auth,LoginClientPolicy policy,org.springframework.beans.factory.ObjectProvider<ai.molis.auth.mail.MailboxMailService> mail,
            ai.molis.auth.verification.RedisMailboxProofs proofs,ExternalAccountService accounts,RedisRateLimiter limiter) {
        return new ProviderMailboxContinuation(new ProviderContinuations(redis,cipher,clock),auth,policy,mail.getIfAvailable(),proofs,accounts,limiter);
    }

    static ProviderClients configured(Settings settings,String issuer,Clock clock) {
        var clients=new ArrayList<ProviderCodeClient>();
        try {
            if (settings==null || !settings.enabled() || !issuer.equals(LoginClientPolicy.origin(issuer)) || !issuer.startsWith("https://")) throw new IllegalArgumentException();
            var google=settings.google();
            if (google!=null && google.enabled()) {
                if (google.clientSecret()==null || !google.clientSecret().matches("[!-~]{1,8192}")) throw new IllegalArgumentException();
                var registration=new ProviderRegistration(IdentityProvider.GOOGLE,google.clientId(),URI.create(issuer+"/oauth2/callback/google"));
                clients.add(ProviderCodeClient.production(registration,ignored->google.clientSecret(),clock));
            }
            var apple=settings.apple();
            if (apple!=null && apple.enabled()) {
                var registration=new ProviderRegistration(IdentityProvider.APPLE,apple.clientId(),URI.create(issuer+"/oauth2/callback/apple"));
                var key=appleKey(apple);
                clients.add(ProviderCodeClient.production(registration,new AppleClientSecret(()->key,clock),clock));
            }
            if (clients.isEmpty()) throw new IllegalArgumentException();
            return new ProviderClients(clients);
        } catch (RuntimeException invalid) {
            clients.forEach(ProviderCodeClient::close);
            throw new IllegalArgumentException("Invalid provider deployment configuration");
        }
    }
    static AppleClientSecret.SigningKey appleKey(Apple settings) {
        byte[] der=null;
        try {
            if (settings.privateKeyBase64()==null || settings.privateKeyBase64().length()>16384) throw new IllegalArgumentException();
            der=Base64.getDecoder().decode(settings.privateKeyBase64());
            var key=KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(der));
            return new AppleClientSecret.SigningKey(settings.teamId(),settings.keyId(),(ECPrivateKey)key);
        } catch (Exception invalid) { throw new IllegalArgumentException("Invalid Apple signing configuration"); }
        finally { if(der!=null)Arrays.fill(der,(byte)0); }
    }
    @ConfigurationProperties("auth.federation")
    public record Settings(boolean enabled,Google google,Apple apple,Crypto crypto) {
        @Override public String toString(){return "ProviderSettings[REDACTED]";}
    }
    public record Google(boolean enabled,String clientId,String clientSecret) {
        @Override public String toString(){return "GoogleSettings[REDACTED]";}
    }
    public record Apple(boolean enabled,String clientId,String teamId,String keyId,String privateKeyBase64) {
        @Override public String toString(){return "AppleSettings[REDACTED]";}
    }
    public record Crypto(String activeKeyId,Map<String,String> keys) {
        public Crypto { if(keys!=null)keys=Map.copyOf(keys); }
        @Override public String toString(){return "ProviderCrypto[REDACTED]";}
    }
    public static final class ProviderClients implements AutoCloseable {
        private final List<ProviderCodeClient> clients;
        ProviderClients(List<ProviderCodeClient> clients){this.clients=List.copyOf(clients);}
        List<ProviderCodeClient> values(){return clients;}
        public List<String> enabledProviders(){return clients.stream().map(client->client.registration().provider().name().toLowerCase(Locale.ROOT)).toList();}
        @Override public void close(){clients.forEach(ProviderCodeClient::close);}
    }
}
