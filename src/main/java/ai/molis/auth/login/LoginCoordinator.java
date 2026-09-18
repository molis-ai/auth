package ai.molis.auth.login;

import ai.molis.auth.account.EmailAddress;
import ai.molis.auth.account.LocalAccountService;
import ai.molis.auth.session.SessionService;
import ai.molis.auth.verification.RedisRateLimiter;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

@Service
@ConditionalOnProperty(name = "auth.login.enabled", havingValue = "true")
public final class LoginCoordinator {
    private final RedisAuthTransactions transactions;
    private final LoginClientPolicy policy;
    private final RedisRateLimiter limiter;
    private final LocalAccountService accounts;
    private final SessionService sessions;
    public LoginCoordinator(RedisAuthTransactions transactions, LoginClientPolicy policy, RedisRateLimiter limiter,
            LocalAccountService accounts, SessionService sessions) {
        this.transactions = transactions; this.policy = policy; this.limiter = limiter; this.accounts = accounts; this.sessions = sessions;
    }
    public Started begin(LoginController.Begin request, String origin, String address) {
        limiter.acquire(RedisRateLimiter.Bucket.BEGIN_IP, address);
        var context = policy.begin(request.clientId(), request.redirectUri(), request.codeChallenge(), request.codeChallengeMethod(),
                request.state(), request.scopes(), request.forceLogin(), origin);
        String token = transactions.create(context);
        return new Started(token, policy.authOrigin() + "/login#transaction=" + token);
    }
    public RedisAuthTransactions.View context(String token, String origin) {
        var view = transactions.read(token); policy.validate(view.context(), origin); return view;
    }
    public String signup(String token,LoginController.Signup body,String origin,String address,String requestId){
        policy.requireAuthOrigin(origin);
        if(!"READY".equals(context(token,origin).status()))throw LoginFailure.invalid();
        limiter.acquire(RedisRateLimiter.Bucket.ACCOUNT_IP,address);
        String email=EmailAddress.canonicalize(body.email());
        limiter.acquire(RedisRateLimiter.Bucket.LOGIN_EMAIL,email);
        if(!body.password().equals(body.confirmPassword()))throw new LoginFailure(400,"PASSWORD_MISMATCH");
        var claim=transactions.claim(token);
        String user;
        try{user=accounts.registerWithoutMailboxVerification(email,body.password(),requestId);}
        catch(ai.molis.auth.account.PasswordHashing.PasswordRejectedException invalid){transactions.denied(token,claim.owner());throw new LoginFailure(400,invalid.getMessage());}
        catch(LocalAccountService.AccountRejectedException duplicate){transactions.finish(token,claim.owner());throw new LoginFailure(409,"ACCOUNT_NOT_AVAILABLE");}
        var root=sessions.createAuthentication(user,false);
        transactions.authenticated(token,claim.owner(),root.authenticationId());
        return policy.authOrigin()+"/complete#transaction="+token;
    }
    public String password(String token, String email, String password, String origin, String address, String requestId) {
        context(token, origin);
        limiter.acquire(RedisRateLimiter.Bucket.LOGIN_IP, address);
        String subject;
        try { subject = EmailAddress.canonicalize(accounts.loginIdentifier(email)); } catch (IllegalArgumentException invalid) { subject = "invalid-email"; }
        limiter.acquire(RedisRateLimiter.Bucket.LOGIN_EMAIL, subject);
        var claim = transactions.claim(token);
        try {
            var root = accounts.login(email, password, false, requestId);
            transactions.authenticated(token, claim.owner(), root.authenticationId());
        } catch (LocalAccountService.AccountRejectedException denied) {
            transactions.denied(token, claim.owner());
            throw new LoginFailure(401, "INVALID_CREDENTIALS");
        }
        return policy.authOrigin() + "/complete#transaction=" + token;
    }
    public String restore(String token, String cookie, String origin) {
        var view = context(token, origin);
        policy.requireAuthOrigin(origin);
        if (!"WEB".equals(view.context().clientType()) || view.context().forceLogin()) throw new LoginFailure(401, "FULL_LOGIN_REQUIRED");
        var root = sessions.resolveBrowserAuthentication(cookie).orElseThrow(() -> new LoginFailure(401, "LOGIN_REQUIRED"));
        var claim = transactions.claim(token);
        transactions.authenticated(token, claim.owner(), root);
        return policy.authOrigin() + "/complete#transaction=" + token;
    }
    public Finished complete(String token, String origin) {
        var view = context(token, origin);
        boolean web = "WEB".equals(view.context().clientType());
        if (web) policy.requireAuthOrigin(origin);
        return issue(transactions.consume(token));
    }
    public Confirmation confirmation(String token, String origin, String browser, String address) {
        policy.requireAuthOrigin(origin);
        limiter.acquire(RedisRateLimiter.Bucket.CONFIRMATION_IP, address);
        var preview = transactions.preview(token); policy.validate(preview.context(), origin);
        var account = sessions.confirmationAccount(preview.root());
        String binding = browser == null ? ai.molis.auth.security.TokenSecrets.generate() : browser;
        String proof = ai.molis.auth.security.TokenSecrets.generate();
        long ttl = transactions.bindCompletion(token, binding, proof, preview.root());
        return new Confirmation(proof, binding, Math.max(1, (ttl + 999) / 1000), account);
    }
    public Finished completeConfirmed(String token, String origin, String browser, String proof, boolean confirmed) {
        policy.requireAuthOrigin(origin);
        if (!confirmed) throw new LoginFailure(400, "LOGIN_CONFIRMATION_REQUIRED");
        context(token, origin);
        return issue(transactions.consumeConfirmed(token, browser, proof));
    }
    public void cancelConfirmation(String token, String origin, String browser, String proof) {
        policy.requireAuthOrigin(origin); context(token, origin);
        transactions.consumeConfirmed(token, browser, proof);
    }
    private Finished issue(RedisAuthTransactions.Completed completed) {
        var c = completed.context();
        var code = sessions.completeAuthorization(completed.root(), c.clientId(), c.id(), c.redirectUri(), c.challenge(), c.scopes(), "WEB".equals(c.clientType()));
        String url = c.redirectUri() + (c.redirectUri().contains("?") ? "&" : "?") + "code=" + encode(code.code()) + "&state=" + encode(c.state());
        return new Finished(url, code.cookieSecret(), code.cookieExpiresAt());
    }
    private static String encode(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }
    public record Started(String transaction, String loginUrl) {
        @Override public String toString() { return "Started[REDACTED]"; }
    }
    public record Confirmation(String proof, String browser, long seconds, SessionService.ConfirmationAccount account) {
        @Override public String toString() { return "Confirmation[REDACTED]"; }
    }
    public record Finished(String redirectTo, String cookieSecret, Instant cookieExpiresAt) {
        @Override public String toString() { return "Finished[REDACTED]"; }
    }
}
