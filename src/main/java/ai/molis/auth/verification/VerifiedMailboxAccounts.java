package ai.molis.auth.verification;

import ai.molis.auth.account.LocalAccountService;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

/**
 * Real Redis proof consumption -> real MySQL account transaction.
 * No distributed transaction is implied: if DB completion is unknown, never restore a consumed proof.
 * The user must verify again or log in normally; durable DB receipts prevent duplicate operation effects.
 * The caller must have checked a live, registered-client-bound authentication transaction and rate limits.
 */
@Service
@ConditionalOnProperty(name = "auth.ephemeral.enabled", havingValue = "true")
public class VerifiedMailboxAccounts {
    private final RedisMailboxProofs proofs;
    private final LocalAccountService accounts;
    public VerifiedMailboxAccounts(RedisMailboxProofs proofs, LocalAccountService accounts) {
        this.proofs = proofs; this.accounts = accounts;
    }
    public String register(String challenge, String transactionSecret, String displayName, String password,
            String locale, String requestId) {
        var proof = proofs.consume(challenge, RedisMailboxProofs.Purpose.REGISTER, transactionSecret);
        return accounts.registerAfterMailboxVerification(proof.operationId(), proof.email(), displayName, password, locale, requestId);
    }
    public String resetPassword(String challenge, String transactionSecret, String password, String locale, String requestId) {
        var proof = proofs.consume(challenge, RedisMailboxProofs.Purpose.PASSWORD_RESET, transactionSecret);
        return accounts.resetPasswordAfterMailboxVerification(proof.operationId(), proof.email(), password, locale, requestId);
    }
}
