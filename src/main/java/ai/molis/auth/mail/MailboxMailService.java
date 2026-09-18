package ai.molis.auth.mail;

import ai.molis.auth.account.AccountEventMapper;
import ai.molis.auth.account.EmailAddress;
import ai.molis.auth.verification.RedisMailboxProofs;
import ai.molis.auth.verification.RedisRateLimiter;
import java.util.UUID;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Call only after validating the originating auth transaction; remoteAddress must come from trusted HTTP handling. */
public final class MailboxMailService {
    private final RedisMailboxProofs proofs;
    private final RedisRateLimiter limiter;
    private final MailOutboxMapper mail;
    private final AccountEventMapper events;
    private final MailPayloadCipher cipher;
    private final TransactionTemplate writes;
    public MailboxMailService(RedisMailboxProofs proofs, RedisRateLimiter limiter, MailOutboxMapper mail,
            AccountEventMapper events, MailPayloadCipher cipher, PlatformTransactionManager transactions) {
        this.proofs = proofs; this.limiter = limiter; this.mail = mail; this.events = events; this.cipher = cipher;
        writes = new TransactionTemplate(transactions);
        writes.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        writes.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED); writes.setTimeout(5);
    }
    public Pending request(String emailInput, RedisMailboxProofs.Purpose purpose, String transactionSecret,
            String locale, String remoteAddress, String requestId) {
        String email = EmailAddress.canonicalize(emailInput);
        String request = UUID.fromString(requestId).toString();
        limiter.acquire(RedisRateLimiter.Bucket.MAIL_IP, remoteAddress);
        limiter.acquire(RedisRateLimiter.Bucket.MAIL_EMAIL, email);
        // Start the DB delivery deadline before Redis creates its relative TTL, never after it.
        var expires = mail.databaseNow().plusSeconds(600);
        var issued = proofs.issue(email, purpose, transactionSecret);
        String id = UUID.randomUUID().toString(), language = "en".equals(locale) ? "en" : "zh-CN";
        String template = switch (purpose) {
            case REGISTER -> "VERIFY_REGISTER";
            case PASSWORD_RESET -> "VERIFY_PASSWORD_RESET";
            case EXTERNAL_IDENTITY -> "VERIFY_EXTERNAL_IDENTITY";
        };
        var metadata = new MailOutboxMapper.Row(id, email, template, language, null, expires, 0);
        String payload = cipher.seal(issued.challenge() + "\n" + issued.deliverySecret(), metadata.context());
        writes.executeWithoutResult(status -> {
            mail.enqueue(new MailOutboxMapper.Row(id, email, template, language, payload, expires, 0));
            events.audit(UUID.randomUUID().toString(), "mail.verification.request", "SUCCESS", null, null, request, mail.databaseNow());
        });
        // No delivery secret in the initiating response. Failure leaves an unreachable Redis challenge to expire.
        return new Pending(issued.challenge());
    }
    public record Pending(String challenge) {}
}
