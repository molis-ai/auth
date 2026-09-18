package ai.molis.auth.mail;

import ai.molis.auth.account.AccountEventMapper;
import ai.molis.auth.verification.RedisMailboxProofs;
import ai.molis.auth.verification.RedisRateLimiter;
import java.net.URI;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.mail.javamail.JavaMailSenderImpl;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.PlatformTransactionManager;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "auth.mail.enabled", havingValue = "true")
@EnableConfigurationProperties(MailConfiguration.CryptoKeys.class)
@EnableScheduling
public class MailConfiguration {
    @Bean MailPayloadCipher mailCipher(CryptoKeys keys) { return new MailPayloadCipher(keys.activeKeyId(), keys.keys()); }
    @Bean MailTemplates mailTemplates(MailPayloadCipher cipher, @Value("${auth.mail.origin}") String origin) {
        return new MailTemplates(cipher, origin);
    }
    @Bean MailTransport mailTransport(@Value("${auth.mail.mode}") String mode,
            @Value("${auth.mail.origin}") String origin, @Value("${server.address}") String address,
            @Value("${auth.mail.smtp.host:}") String host, @Value("${auth.mail.smtp.port:587}") int port,
            @Value("${auth.mail.smtp.username:}") String user, @Value("${auth.mail.smtp.password:}") String password,
            @Value("${auth.mail.smtp.from:}") String from, @Value("${auth.mail.smtp.implicit-tls:false}") boolean implicitTls) {
        if (mode.equals("inbox")) {
            if (!loopback(URI.create(origin).getHost()) || !loopback(address))
                throw new IllegalArgumentException("Development inbox requires loopback origin and bind address");
            return new DevelopmentInbox();
        }
        if (!mode.equals("smtp") || host.isBlank() || port < 1 || port > 65535)
            throw new IllegalArgumentException("Explicit SMTP configuration required");
        var sender = new JavaMailSenderImpl();
        sender.setHost(host); sender.setPort(port); sender.setDefaultEncoding("UTF-8");
        if (!user.isBlank()) { sender.setUsername(user); sender.setPassword(password); }
        var properties = sender.getJavaMailProperties();
        properties.setProperty("mail.smtp.auth", Boolean.toString(!user.isBlank()));
        properties.setProperty("mail.smtp.ssl.enable", Boolean.toString(implicitTls));
        properties.setProperty("mail.smtp.starttls.enable", Boolean.toString(!implicitTls));
        properties.setProperty("mail.smtp.starttls.required", Boolean.toString(!implicitTls));
        properties.setProperty("mail.smtp.ssl.checkserveridentity", "true");
        properties.setProperty("mail.smtp.connectiontimeout", "3000");
        properties.setProperty("mail.smtp.timeout", "5000");
        properties.setProperty("mail.smtp.writetimeout", "5000");
        properties.setProperty("mail.debug", "false");
        return new SmtpMailTransport(sender, from);
    }
    @Bean MailDispatcher mailDispatcher(MailOutboxMapper mapper, MailTemplates templates, MailTransport transport,
            PlatformTransactionManager transactions) { return new MailDispatcher(mapper, templates, transport, transactions); }
    @Bean @ConditionalOnProperty(name = "auth.ephemeral.enabled", havingValue = "true")
    MailboxMailService mailboxMailService(RedisMailboxProofs proofs, RedisRateLimiter limiter, MailOutboxMapper mapper,
            AccountEventMapper events, MailPayloadCipher cipher, PlatformTransactionManager transactions) {
        return new MailboxMailService(proofs, limiter, mapper, events, cipher, transactions);
    }
    @Bean @ConditionalOnProperty(name = "auth.mail.worker.enabled", havingValue = "true")
    Worker mailWorker(MailDispatcher dispatcher) { return new Worker(dispatcher); }
    private static boolean loopback(String value) { return "localhost".equals(value) || "127.0.0.1".equals(value) || "::1".equals(value) || "[::1]".equals(value); }

    @ConfigurationProperties("auth.mail.crypto")
    public record CryptoKeys(String activeKeyId, Map<String, String> keys) {
        @Override public String toString() { return "MailCryptoKeys[REDACTED]"; }
    }
    static final class Worker {
        private final MailDispatcher dispatcher;
        Worker(MailDispatcher dispatcher) { this.dispatcher = dispatcher; }
        @Scheduled(fixedDelayString = "${auth.mail.worker.delay-ms:5000}")
        public void deliver() {
            try { for (int i = 0; i < 10 && dispatcher.dispatchNext(); i++) { /* bounded batch */ } }
            catch (RuntimeException unavailable) {
                org.slf4j.LoggerFactory.getLogger(Worker.class).warn("Mail dispatch incomplete; will retry after lease recovery");
            }
        }
    }
}
