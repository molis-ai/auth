package ai.molis.auth.login;

import ai.molis.auth.account.LocalAccountService;
import ai.molis.auth.account.PasswordHashing;
import ai.molis.auth.mail.MailboxMailService;
import ai.molis.auth.session.SessionService;
import ai.molis.auth.verification.EphemeralFailure;
import ai.molis.auth.verification.RedisMailboxProofs;
import ai.molis.auth.verification.RedisRateLimiter;
import ai.molis.auth.verification.VerifiedMailboxAccounts;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

/** Client-bound public orchestration; mailbox identity comes exclusively from consumed server proofs. */
@Service
@ConditionalOnProperty(name = {"auth.login.enabled", "auth.mail.enabled"}, havingValue = "true")
public final class MailboxAccountCoordinator {
    private final LoginCoordinator login;
    private final LoginClientPolicy policy;
    private final RedisAuthTransactions transactions;
    private final MailboxMailService mail;
    private final RedisMailboxProofs proofs;
    private final RedisRateLimiter limiter;
    private final VerifiedMailboxAccounts accounts;
    private final PasswordHashing passwords;
    private final SessionService sessions;
    public MailboxAccountCoordinator(LoginCoordinator login, LoginClientPolicy policy, RedisAuthTransactions transactions,
            MailboxMailService mail, RedisMailboxProofs proofs, RedisRateLimiter limiter, VerifiedMailboxAccounts accounts,
            PasswordHashing passwords, SessionService sessions) {
        this.login = login; this.policy = policy; this.transactions = transactions; this.mail = mail;
        this.proofs = proofs; this.limiter = limiter; this.accounts = accounts; this.passwords = passwords; this.sessions = sessions;
    }
    public MailboxMailService.Pending request(String transaction, String origin, MailboxAccountController.MailRequest body,
            String address, String requestId) {
        requireReady(transaction, origin);
        // Provider continuation owns this purpose; ordinary registration must not mint its proofs.
        if (body.purpose() != RedisMailboxProofs.Purpose.REGISTER && body.purpose() != RedisMailboxProofs.Purpose.PASSWORD_RESET)
            throw new LoginFailure(400, "INVALID_REQUEST");
        // Same response shape for unknown, local and external-only accounts. No account enumeration here.
        return mail.request(body.email(), body.purpose(), transaction, body.locale(), address, requestId);
    }
    public void verify(String origin, String challenge, String secret, String address) {
        policy.requireAuthOrigin(origin);
        limiter.acquire(RedisRateLimiter.Bucket.VERIFY_IP, address);
        proofs.verifyLink(challenge, secret);
    }
    public String register(String transaction, String origin, MailboxAccountController.Register body, String address, String requestId) {
        requireReady(transaction, origin);
        limiter.acquire(RedisRateLimiter.Bucket.ACCOUNT_IP, address);
        passwords.validateNew(body.password());
        if (body.displayName().codePoints().anyMatch(Character::isISOControl)) throw new LoginFailure(400, "INVALID_REQUEST");
        var claim = transactions.claim(transaction);
        String user;
        try {
            user = accounts.register(body.challenge(), transaction, body.displayName(), body.password(), body.locale(), requestId);
        } catch (EphemeralFailure invalid) { releaseInvalidProof(transaction, claim.owner(), invalid); throw invalid; }
        catch (LocalAccountService.AccountRejectedException rejected) {
            transactions.finish(transaction, claim.owner());
            throw new LoginFailure(409, "ACCOUNT_NOT_AVAILABLE");
        }
        // The verified registration is durable even if this later authentication step fails.
        // Never restore a consumed proof/transaction: the account can use normal password login.
        var root = sessions.createAuthentication(user, false);
        transactions.authenticated(transaction, claim.owner(), root.authenticationId());
        return policy.authOrigin() + "/complete#transaction=" + transaction;
    }
    public void reset(String transaction, String origin, MailboxAccountController.Reset body, String address, String requestId) {
        requireReady(transaction, origin);
        limiter.acquire(RedisRateLimiter.Bucket.ACCOUNT_IP, address);
        passwords.validateNew(body.password());
        var claim = transactions.claim(transaction);
        try {
            accounts.resetPassword(body.challenge(), transaction, body.password(), body.locale(), requestId);
        } catch (EphemeralFailure invalid) { releaseInvalidProof(transaction, claim.owner(), invalid); throw invalid; }
        catch (LocalAccountService.AccountRejectedException rejected) {
            transactions.finish(transaction, claim.owner());
            throw new LoginFailure(400, "RESET_NOT_AVAILABLE");
        }
        // Reset revokes all sessions and does not silently establish a replacement session.
        transactions.finish(transaction, claim.owner());
    }
    private void requireReady(String transaction, String origin) {
        if (!"READY".equals(login.context(transaction, origin).status())) throw LoginFailure.invalid();
    }
    private void releaseInvalidProof(String transaction, String owner, EphemeralFailure failure) {
        // Unknown Redis outcome stays BUSY. Only a definite invalid proof permits a bounded retry.
        if (failure.reason() == EphemeralFailure.Reason.INVALID_PROOF) transactions.denied(transaction, owner);
    }
}
