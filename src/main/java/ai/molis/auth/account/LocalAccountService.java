package ai.molis.auth.account;

import ai.molis.auth.authorization.SpaceRole;
import ai.molis.auth.persistence.AccountMapper;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.SessionMapper;
import ai.molis.auth.session.SessionService.AuthenticationCreated;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Objects;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Internal account workflow, NOT an HTTP API. Password-only signup records an
 * unverified identifier. Legacy verified registration/reset require the verification
 * layer to consume a purpose-bound, unexpired server-side mailbox proof.
 * operationId is the verified proof's immutable server ID, not a client idempotency key
 * and never proof of identity by itself. Shared rate limiting must precede login/KDF work.
 */
@Service
public class LocalAccountService {
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private DevelopmentAdmin developmentAdmin;

    public String loginIdentifier(String value) {
        return developmentAdmin == null ? value : developmentAdmin.resolve(value);
    }
    private final AccountMapper accounts;
    private final AccountOperationMapper operations;
    private final AccountEventMapper events;
    private final SessionMapper sessions;
    private final PasswordHashing passwords;
    private final Clock clock;
    private final TransactionTemplate writes;
    private final TransactionTemplate reads;

    public LocalAccountService(AccountMapper accounts, AccountOperationMapper operations, AccountEventMapper events,
            SessionMapper sessions, PasswordHashing passwords, Clock clock, PlatformTransactionManager transactions) {
        this.accounts = accounts; this.operations = operations; this.events = events;
        this.sessions = sessions; this.passwords = passwords; this.clock = clock;
        writes = transaction(transactions, false);
        reads = transaction(transactions, true);
    }

    public String registerWithoutMailboxVerification(String inputEmail,String password,String requestId){
        String email=EmailAddress.canonicalize(inputEmail), request=uuid(requestId);
        String hash=passwords.encodeNew(password);
        try{return Objects.requireNonNull(writes.execute(tx->{
            if(operations.findCredential(email)!=null)throw rejected("ACCOUNT_EXISTS");
            String user=id(),space=id();
            accounts.insertUser(user,email.substring(0,email.indexOf('@')));
            accounts.insertUnverifiedEmail(id(),user,email);
            accounts.insertLocalCredential(user,hash);
            accounts.insertPersonalSpace(space,user,"个人空间");
            accounts.insertMembership(space,user,SpaceRole.OWNER);
            audit("account.register",true,user,request,now());
            return user;
        }));}catch(DuplicateKeyException collision){throw rejected("ACCOUNT_EXISTS");}
    }
    public String registerAfterMailboxVerification(String operationId, String verifiedEmail, String displayName,
            String rawPassword, String locale, String requestId) {
        String operation = uuid(operationId), request = uuid(requestId), email = EmailAddress.canonicalize(verifiedEmail);
        if (displayName == null || displayName.isBlank() || displayName.codePointCount(0, displayName.length()) > 120
                || displayName.codePoints().anyMatch(Character::isISOControl)) throw rejected("INVALID_DISPLAY_NAME");
        String language = language(locale);
        String hash = passwords.encodeNew(rawPassword);
        try {
            return Objects.requireNonNull(writes.execute(status -> {
                var receipt = operations.findReceipt(operation);
                if (receipt != null) return receiptUser(receipt, "REGISTER", email);
                if (operations.findCredential(email) != null) {
                    // Another node may have committed after the first receipt read. Seeing its
                    // mailbox requires re-reading its atomically committed receipt before rejecting.
                    receipt = operations.findReceipt(operation);
                    if (receipt != null) return receiptUser(receipt, "REGISTER", email);
                    throw rejected("ACCOUNT_EXISTS");
                }
                String user = id(), space = id();
                Instant now = now();
                accounts.insertUser(user, displayName.strip());
                accounts.insertVerifiedEmail(id(), user, email);
                accounts.insertLocalCredential(user, hash);
                accounts.insertPersonalSpace(space, user, "zh-CN".equals(language) ? "个人空间" : "Personal space");
                accounts.insertMembership(space, user, SpaceRole.OWNER);
                operations.receipt(operation, "REGISTER", email, user, now);
                audit("account.register", true, user, request, now);
                events.mail(id(), email, "ACCOUNT_REGISTERED", language, now);
                return user;
            }));
        } catch (DuplicateKeyException collision) {
            // Re-read only AFTER the failed transaction is rolled back; never commit partial aggregates.
            var receipt = reads.execute(status -> operations.findReceipt(operation));
            if (receipt != null) return receiptUser(receipt, "REGISTER", email);
            if (reads.execute(status -> operations.findCredential(email)) != null) throw rejected("ACCOUNT_EXISTS");
            throw collision;
        }
    }

    public AuthenticationCreated login(String emailInput, String rawPassword, boolean browserRestore, String requestId) {
        String request = uuid(requestId);
        String email;
        try { email = EmailAddress.canonicalize(loginIdentifier(emailInput)); }
        catch (IllegalArgumentException invalid) { email = null; }
        final String lookup = email;
        var candidate = lookup == null ? null : reads.execute(status -> operations.findCredential(lookup));
        boolean matched = passwords.matches(rawPassword, candidate == null ? null : candidate.passwordHash());
        var result = writes.execute(status -> {
            String user = candidate == null ? null : candidate.userId();
            String userStatus = user == null ? null : sessions.lockUser(user);
            String currentHash = user == null ? null : operations.lockPassword(user);
            // A reset can finish while the KDF runs. Recheck the credential under the user lock.
            boolean accepted = matched && "ACTIVE".equals(userStatus)
                    && Objects.equals(currentHash, candidate.passwordHash());
            Instant now = now();
            audit("account.login", accepted, user, request, now);
            if (!accepted) return null;
            String authentication = id(), cookie = browserRestore ? TokenSecrets.generate() : null;
            sessions.insertAuthentication(authentication, user, cookie == null ? null : TokenSecrets.digest(cookie), now);
            return new AuthenticationCreated(authentication, cookie);
        });
        // Commit denial audit before reporting the generic credential failure.
        if (result == null) throw rejected("INVALID_CREDENTIALS");
        return result;
    }

    public String resetPasswordAfterMailboxVerification(String operationId, String verifiedEmail, String rawPassword,
            String locale, String requestId) {
        String operation = uuid(operationId), request = uuid(requestId), email = EmailAddress.canonicalize(verifiedEmail);
        String language = language(locale), hash = passwords.encodeNew(rawPassword);
        return Objects.requireNonNull(writes.execute(status -> {
            var prior = operations.findReceipt(operation);
            if (prior != null) return receiptUser(prior, "PASSWORD_RESET", email);
            var candidate = operations.findCredential(email);
            if (candidate == null || !"ACTIVE".equals(sessions.lockUser(candidate.userId())))
                throw rejected("RESET_NOT_AVAILABLE");
            // Recheck receipt after serializing this user's operations, including concurrent reset retries.
            prior = operations.findReceipt(operation);
            if (prior != null) return receiptUser(prior, "PASSWORD_RESET", email);
            String user = candidate.userId();
            if (operations.lockPassword(user) == null) throw rejected("RESET_NOT_AVAILABLE");
            Instant now = now();
            if (operations.changePassword(user, hash, now) != 1) throw rejected("RESET_NOT_AVAILABLE");
            sessions.revokeUserAuthentications(user, now);
            sessions.revokeUserGrants(user, now);
            operations.receipt(operation, "PASSWORD_RESET", email, user, now);
            audit("account.password.reset", true, user, request, now);
            events.mail(id(), email, "PASSWORD_CHANGED", language, now);
            return user;
        }));
    }

    private void audit(String action, boolean success, String user, String request, Instant now) {
        events.audit(id(), action, success ? "SUCCESS" : "DENIED", success ? user : null, user, request, now);
    }
    private static String receiptUser(AccountOperationMapper.Receipt receipt, String purpose, String email) {
        if (!receipt.purpose().equals(purpose) || !receipt.email().equals(email)) throw rejected("INVALID_VERIFICATION");
        return receipt.userId();
    }
    private static TransactionTemplate transaction(PlatformTransactionManager manager, boolean readOnly) {
        var template = new TransactionTemplate(manager);
        template.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        template.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        template.setReadOnly(readOnly);
        template.setTimeout(readOnly ? 3 : 10);
        return template;
    }
    private static String uuid(String value) {
        if (value == null || !value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
            throw rejected("INVALID_OPERATION_ID");
        return UUID.fromString(value).toString();
    }
    private static String language(String value) { return "en".equals(value) ? "en" : "zh-CN"; }
    private Instant now() { return clock.instant().truncatedTo(ChronoUnit.MICROS); }
    private static String id() { return UUID.randomUUID().toString(); }
    private static AccountRejectedException rejected(String code) { return new AccountRejectedException(code); }
    public static final class AccountRejectedException extends RuntimeException {
        public AccountRejectedException(String code) { super(code); }
    }
}
