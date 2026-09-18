package ai.molis.auth.session;

import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.security.Pkce;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Arrays;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Durable session engine used by trusted authentication/grant workflows, not a controller.
 * Creating a root requires completed identity verification. Creating a grant requires a
 * validated authentication transaction/redirect/PKCE flow. These IDs are not credentials.
 * All writes acquire the user row first; refresh consumption and issuance commit together.
 */
@Service
public class SessionService {
    private static final Duration ACCESS_TTL = Duration.ofMinutes(15);
    private static final Duration REFRESH_TTL = Duration.ofDays(30);
    private final SessionMapper mapper;
    private final AuthorizationCodeMapper codes;
    private final Clock clock;
    private final TransactionTemplate writes;
    private final TransactionTemplate reads;

    public SessionService(SessionMapper mapper, AuthorizationCodeMapper codes, Clock clock, PlatformTransactionManager transactions) {
        this.mapper = mapper;
        this.codes = codes;
        this.clock = clock;
        this.writes = new TransactionTemplate(transactions);
        // A replay revocation must commit even if the HTTP layer or its caller later throws.
        this.writes.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.writes.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.writes.setTimeout(10);
        this.reads = new TransactionTemplate(transactions);
        this.reads.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.reads.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.reads.setReadOnly(true);
        this.reads.setTimeout(3);
    }

    public AuthenticationCreated createAuthentication(String verifiedUserId, boolean browserRestore) {
        return Objects.requireNonNull(writes.execute(status -> {
            if (!"ACTIVE".equals(mapper.lockUser(verifiedUserId))) throw rejected(Reason.INACTIVE);
            Instant now = now();
            String id = id();
            String cookie = browserRestore ? TokenSecrets.generate() : null;
            mapper.insertAuthentication(id, verifiedUserId, cookie == null ? null : TokenSecrets.digest(cookie), now);
            return new AuthenticationCreated(id, cookie);
        }));
    }

    public Optional<String> resolveBrowserAuthentication(String cookie) {
        if (!validSecret(cookie)) return Optional.empty();
        return Objects.requireNonNull(reads.execute(status -> {
            var row = mapper.findCookie(TokenSecrets.digest(cookie));
            return active(row, now()) ? Optional.of(row.id()) : Optional.empty();
        }));
    }

    public String createGrant(String authenticationId, String clientId, Set<String> requestedScopes) {
        Set<String> requested = requestedScopes == null ? Set.of() : Set.copyOf(requestedScopes);
        String encoded = encodeScopes(requested);
        return Objects.requireNonNull(writes.execute(status -> {
            var candidate = mapper.findAuthentication(authenticationId);
            if (candidate == null) throw rejected(Reason.INACTIVE);
            mapper.lockUser(candidate.userId());
            var client = mapper.lockClient(clientId);
            var root = mapper.lockAuthentication(authenticationId);
            Instant now = now();
            if (!active(root, now) || client == null || !client.clientId().equals(clientId) || !"ACTIVE".equals(client.clientStatus())
                    || !"ACTIVE".equals(client.applicationStatus())) throw rejected(Reason.INACTIVE);
            if (!decodeScopes(client.allowedScopes()).containsAll(requested)) throw rejected(Reason.INVALID_SCOPE);
            String id = id();
            mapper.insertGrant(id, root.id(), client.id(), encoded, now);
            return id;
        }));
    }

    /** Identity preview for a server-owned authenticated transaction, never an arbitrary HTTP user ID. */
    public ConfirmationAccount confirmationAccount(String authenticationId) {
        return Objects.requireNonNull(reads.execute(status -> {
            var root = mapper.findAuthentication(authenticationId);
            if (!active(root, now())) throw rejected(Reason.INACTIVE);
            return new ConfirmationAccount(root.userId(), java.util.List.copyOf(mapper.confirmationEmails(root.userId())));
        }));
    }
    public record ConfirmationAccount(String userId, java.util.List<String> emails) {}

    public TokenPair issueInitial(String sessionId) {
        return Objects.requireNonNull(writes.execute(status -> {
            var context = lockContext(sessionId);
            Instant now = now();
            if (!active(context, now)) throw rejected(Reason.INACTIVE);
            if (context.issuedAt() != null) throw rejected(Reason.ALREADY_ISSUED);
            if (mapper.markIssued(sessionId, now) != 1) throw rejected(Reason.ALREADY_ISSUED);
            return mint(context, decodeScopes(context.scopes()), now);
        }));
    }

    /**
     * Called only after a verified authentication transaction. The UUID binds issuance to
     * that one server-side transaction; this method is never a public code-minting API.
     */
    public AuthorizationCodeCreated createAuthorizationCode(String authenticationId, String clientId,
            String transactionId, String redirectUri, String challenge, Set<String> scopes) {
        return completeAuthorization(authenticationId, clientId, transactionId, redirectUri, challenge, scopes, false);
    }

    /** Trusted completed auth transaction only; browser cookie creation and code issuance commit together. */
    public AuthorizationCodeCreated completeAuthorization(String authenticationId, String clientId,
            String transactionId, String redirectUri, String challenge, Set<String> scopes, boolean browserCookie) {
        if (!Pkce.validChallenge(challenge) || redirectUri == null || redirectUri.length() > 1024
                || transactionId == null || !transactionId.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
            throw rejected(Reason.INVALID_GRANT);
        Set<String> requested = scopes == null ? Set.of() : Set.copyOf(scopes);
        String encoded = encodeScopes(requested);
        return Objects.requireNonNull(writes.execute(status -> {
            var locator = mapper.findAuthentication(authenticationId);
            if (locator == null) throw rejected(Reason.INACTIVE);
            mapper.lockUser(locator.userId());
            var client = mapper.lockClient(clientId);
            var root = mapper.lockAuthentication(authenticationId);
            Instant now = now();
            if (!active(root, now) || client == null || !client.clientId().equals(clientId) || !"ACTIVE".equals(client.clientStatus())
                    || !"ACTIVE".equals(client.applicationStatus())) throw rejected(Reason.INACTIVE);
            if (!decodeScopes(client.allowedScopes()).containsAll(requested)) throw rejected(Reason.INVALID_SCOPE);
            if (!redirectUri.equals(codes.lockRedirect(clientId, redirectUri))) throw rejected(Reason.INVALID_GRANT);
            String cookie = null;
            if (browserCookie) {
                if (!"WEB".equals(client.clientType())) throw rejected(Reason.INVALID_GRANT);
                String candidateCookie = TokenSecrets.generate();
                if (mapper.attachBrowserCookie(authenticationId, TokenSecrets.digest(candidateCookie)) == 1) cookie = candidateCookie;
            }
            String sessionId = id();
            mapper.insertGrant(sessionId, authenticationId, client.id(), encoded, now);
            Instant expires = min(now.plusSeconds(60),
                    new SessionLifetime(root.authenticatedAt(), root.lastUserActivityAt()).expiresAt());
            String code = TokenSecrets.generate();
            codes.insert(TokenSecrets.digest(code), sessionId, transactionId, redirectUri, challenge, now, expires);
            return new AuthorizationCodeCreated(sessionId, code, redirectUri, expires, cookie,
                    root.authenticatedAt().plus(SessionLifetime.ABSOLUTE_LIMIT));
        }));
    }

    public TokenPair exchangeCode(String clientId, String code, String redirectUri, String verifier) {
        if (!validSecret(code)) throw rejected(Reason.INVALID_GRANT);
        String hash = TokenSecrets.digest(code);
        Rotation result = Objects.requireNonNull(writes.execute(status -> {
            var candidate = codes.find(hash);
            if (candidate == null) return Rotation.denied(Reason.INVALID_GRANT);
            var locator = mapper.findGrant(candidate.sessionId());
            if (locator == null || !locator.clientId().equals(clientId)) return Rotation.denied(Reason.INVALID_GRANT);
            var context = lockContext(candidate.sessionId());
            var current = codes.lock(hash);
            Instant now = now();
            if (current == null || context == null || !context.clientId().equals(clientId)
                    || !current.redirectUri().equals(redirectUri) || !Pkce.matches(current.pkceChallenge(), verifier)) {
                return Rotation.denied(Reason.INVALID_GRANT);
            }
            if (!active(context, now)) return Rotation.denied(Reason.INACTIVE);
            if (!current.redirectUri().equals(codes.lockRedirect(clientId, current.redirectUri()))) {
                return Rotation.denied(Reason.INVALID_GRANT);
            }
            if (current.consumedAt() != null) {
                mapper.revokeGrant(context.sessionId(), now);
                return Rotation.denied(Reason.REPLAY);
            }
            if (!now.isBefore(current.expiresAt()) || context.issuedAt() != null) return Rotation.denied(Reason.INVALID_GRANT);
            if (codes.consume(hash, now) != 1 || mapper.markIssued(context.sessionId(), now) != 1) {
                throw new IllegalStateException("Authorization code lock invariant violated");
            }
            return Rotation.allowed(mint(context, decodeScopes(context.scopes()), now));
        }));
        if (result.reason() != null) throw rejected(result.reason());
        return result.tokens();
    }

    public TokenPair rotate(String clientId, String refreshToken, Set<String> requestedScopes) {
        if (!validSecret(refreshToken)) throw rejected(Reason.INVALID_GRANT);
        Set<String> requested = requestedScopes == null ? Set.of() : Set.copyOf(requestedScopes);
        String hash = TokenSecrets.digest(refreshToken);
        Rotation result = Objects.requireNonNull(writes.execute(status -> {
            var candidate = mapper.findRefresh(hash);
            if (candidate == null) return Rotation.denied(Reason.INVALID_GRANT);
            var locator = mapper.findGrant(candidate.sessionId());
            // Check ownership before any revocation, including for already consumed tokens.
            if (locator == null || !locator.clientId().equals(clientId)) return Rotation.denied(Reason.INVALID_GRANT);
            var context = lockContext(candidate.sessionId());
            var current = mapper.lockRefresh(hash);
            Instant now = now();
            if (context == null || !context.clientId().equals(clientId) || current == null) {
                return Rotation.denied(Reason.INVALID_GRANT);
            }
            if (!active(context, now)) return Rotation.denied(Reason.INACTIVE);
            if (current.consumedAt() != null) {
                mapper.revokeGrant(context.sessionId(), now);
                return Rotation.denied(Reason.REPLAY);
            }
            if (!now.isBefore(current.expiresAt())) return Rotation.denied(Reason.INVALID_GRANT);
            Set<String> allowed = decodeScopes(context.scopes());
            if (!allowed.containsAll(requested)) return Rotation.denied(Reason.INVALID_SCOPE);
            if (mapper.consumeRefresh(hash, now) != 1) throw new IllegalStateException("Refresh lock invariant violated");
            return Rotation.allowed(mint(context, requested.isEmpty() ? allowed : requested, now));
        }));
        // Deliberately outside the committed transaction. No blanket noRollbackFor policy.
        if (result.reason() != null) throw rejected(result.reason());
        return result.tokens();
    }

    /** For Auth-owned account/session APIs; the caller must check the required account scope. */
    public Optional<UserPrincipal> resolveAccessForAuth(String accessToken) {
        if (!validSecret(accessToken)) return Optional.empty();
        return Objects.requireNonNull(reads.execute(status -> {
            var row = mapper.findAccess(TokenSecrets.digest(accessToken));
            Instant now = now();
            if (!active(row, now) || row.tokenExpiresAt() == null || !now.isBefore(row.tokenExpiresAt())) {
                return Optional.empty();
            }
            return Optional.of(principal(row));
        }));
    }

    public Optional<UserPrincipal> resolveAccessForApplication(String accessToken, String applicationId) {
        if (applicationId == null || applicationId.isBlank()) return Optional.empty();
        return resolveAccessForAuth(accessToken).filter(principal -> principal.applicationId().equals(applicationId));
    }

    /** Internal composition only: caller owns a READ_COMMITTED transaction; do not expose IDs as credentials. */
    public UserPrincipal requireActiveAccessLocked(String accessToken, String requiredScope) {
        if (!org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive())
            throw new IllegalStateException("An account transaction is required");
        if (!validSecret(accessToken)) throw rejected(Reason.INVALID_GRANT);
        String hash = TokenSecrets.digest(accessToken);
        var candidate = mapper.findAccess(hash);
        if (candidate == null) throw rejected(Reason.INVALID_GRANT);
        var context = lockContext(candidate.sessionId());
        var token = mapper.findAccess(hash);
        Instant now = now();
        if (!active(context, now) || !active(token, now) || token.tokenExpiresAt() == null || !now.isBefore(token.tokenExpiresAt()))
            throw rejected(Reason.INACTIVE);
        var principal = principal(token);
        if (!principal.scopes().contains(requiredScope)) throw rejected(Reason.INVALID_SCOPE);
        return principal;
    }

    /** Only invoke after a trusted interactive request, never a background token refresh. */
    public void recordUserActivity(String accessToken) {
        if (!validSecret(accessToken)) throw rejected(Reason.INVALID_GRANT);
        writes.executeWithoutResult(status -> {
            var candidate = mapper.findAccess(TokenSecrets.digest(accessToken));
            if (candidate == null) throw rejected(Reason.INVALID_GRANT);
            var row = lockContext(candidate.sessionId());
            Instant now = now();
            if (!active(row, now) || !now.isBefore(candidate.tokenExpiresAt())) throw rejected(Reason.INACTIVE);
            mapper.touchAuthentication(row.authenticationId(), now);
            mapper.touchGrant(row.sessionId(), now);
        });
    }
    /** Internal composition for browser-bound identity linking; IDs must come from a verified access token. */
    public void requireRecentBindingGrantLocked(String userId,String grantId,String clientId) {
        if(!org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive())
            throw new IllegalStateException("Binding requires a transaction");
        var row=lockContext(grantId);var now=now();
        if(row==null||!row.userId().equals(userId)||!row.clientId().equals(clientId)||!active(row,now)
                ||row.issuedAt()==null||!decodeScopes(row.scopes()).contains("account"))
            throw new ai.molis.auth.login.LoginFailure(401,"UNAUTHENTICATED");
        if(row.authenticatedAt().isAfter(now)||!now.isBefore(row.authenticatedAt().plusSeconds(300)))
            throw new ai.molis.auth.login.LoginFailure(403,"REAUTHENTICATION_REQUIRED");
    }

    public void revokeSession(String authenticatedUserId, String sessionId) {
        writes.executeWithoutResult(status -> {
            var row = lockContext(sessionId);
            if (row == null || !row.userId().equals(authenticatedUserId)) throw rejected(Reason.INVALID_GRANT);
            mapper.revokeGrant(sessionId, now());
        });
    }

    public void revokeAll(String authenticatedUserId) {
        writes.executeWithoutResult(status -> {
            if (mapper.lockUser(authenticatedUserId) == null) throw rejected(Reason.INACTIVE);
            revokeAllLocked(authenticatedUserId, now());
        });
    }

    /** Platform authorization is required by the caller; never expose this method directly. */
    public void disableUser(String userId) {
        writes.executeWithoutResult(status -> {
            if (mapper.lockUser(userId) == null) throw rejected(Reason.INACTIVE);
            Instant now = now();
            mapper.disableUser(userId, now);
            revokeAllLocked(userId, now);
        });
    }

    private void revokeAllLocked(String userId, Instant now) {
        mapper.revokeUserAuthentications(userId, now);
        mapper.revokeUserGrants(userId, now);
    }

    private SessionMapper.GrantRow lockContext(String sessionId) {
        var candidate = mapper.findGrant(sessionId);
        if (candidate == null) return null;
        mapper.lockUser(candidate.userId());
        mapper.lockClient(candidate.clientId());
        mapper.lockAuthentication(candidate.authenticationId());
        mapper.lockGrantRecord(sessionId);
        // All mutable source rows are now held: user/root/grant exclusive, client/app shared.
        // READ_COMMITTED gives a fresh joined snapshot without upgrading shared configuration locks.
        return mapper.findGrant(sessionId);
    }

    private TokenPair mint(SessionMapper.GrantRow context, Set<String> accessScopes, Instant now) {
        var root = new SessionLifetime(context.authenticatedAt(), context.authenticationLastActivityAt());
        var grant = new SessionLifetime(context.authenticatedAt(), context.lastUserActivityAt());
        Instant accessExpires = min(root.tokenExpiresAt(now, ACCESS_TTL), grant.tokenExpiresAt(now, ACCESS_TTL));
        Instant refreshExpires = min(root.tokenExpiresAt(now, REFRESH_TTL), grant.tokenExpiresAt(now, REFRESH_TTL));
        String access = TokenSecrets.generate();
        String refresh = TokenSecrets.generate();
        mapper.insertToken(TokenSecrets.digest(access), context.sessionId(), "ACCESS", encodeScopes(accessScopes),
                now, accessExpires);
        mapper.insertToken(TokenSecrets.digest(refresh), context.sessionId(), "REFRESH", context.scopes(),
                now, refreshExpires);
        return new TokenPair(context.sessionId(), access, refresh, now, accessExpires, refreshExpires, Set.copyOf(accessScopes));
    }

    private static boolean active(SessionMapper.AuthenticationRow row, Instant now) {
        return row != null && "ACTIVE".equals(row.userStatus()) && row.revokedAt() == null
                && new SessionLifetime(row.authenticatedAt(), row.lastUserActivityAt()).isActiveAt(now);
    }

    private static boolean active(SessionMapper.GrantRow row, Instant now) {
        return row != null && "ACTIVE".equals(row.userStatus()) && "ACTIVE".equals(row.applicationStatus())
                && "ACTIVE".equals(row.clientStatus()) && row.revokedAt() == null && row.authenticationRevokedAt() == null
                && new SessionLifetime(row.authenticatedAt(), row.authenticationLastActivityAt()).isActiveAt(now)
                && new SessionLifetime(row.authenticatedAt(), row.lastUserActivityAt()).isActiveAt(now);
    }

    private static UserPrincipal principal(SessionMapper.GrantRow row) {
        return new UserPrincipal(row.userId(), row.applicationId(), row.clientId(), row.sessionId(),
                row.authenticationId(), decodeScopes(row.tokenScopes()));
    }

    private static String encodeScopes(Set<String> scopes) {
        if (scopes == null || scopes.isEmpty()
                || scopes.stream().anyMatch(scope -> scope == null || !scope.matches("[\\x21\\x23-\\x5B\\x5D-\\x7E]+"))) {
            throw rejected(Reason.INVALID_SCOPE);
        }
        String encoded = String.join(" ", new TreeSet<>(scopes));
        if (encoded.length() > 1000) throw rejected(Reason.INVALID_SCOPE);
        return encoded;
    }

    private static Set<String> decodeScopes(String scopes) {
        return Set.copyOf(Arrays.asList(scopes.split(" ")));
    }

    private static boolean validSecret(String token) { return token != null && token.matches("[A-Za-z0-9_-]{43}"); }
    private Instant now() { return clock.instant().truncatedTo(ChronoUnit.MICROS); }
    private static String id() { return UUID.randomUUID().toString(); }
    private static Instant min(Instant first, Instant second) { return first.isBefore(second) ? first : second; }
    private static SessionRejectedException rejected(Reason reason) { return new SessionRejectedException(reason); }

    public enum Reason { INVALID_GRANT, INVALID_SCOPE, INACTIVE, REPLAY, ALREADY_ISSUED }
    public static final class SessionRejectedException extends RuntimeException {
        private final Reason reason;
        SessionRejectedException(Reason reason) { super("Session request rejected: " + reason); this.reason = reason; }
        public Reason reason() { return reason; }
    }

    public record AuthenticationCreated(String authenticationId, String cookieSecret) {
        @Override public String toString() { return "AuthenticationCreated[authenticationId=" + authenticationId + ", cookie=REDACTED]"; }
    }
    public record AuthorizationCodeCreated(String sessionId, String code, String redirectUri, Instant expiresAt,
            @com.fasterxml.jackson.annotation.JsonIgnore String cookieSecret, Instant cookieExpiresAt) {
        @Override public String toString() { return "AuthorizationCodeCreated[sessionId=" + sessionId + ", code=REDACTED]"; }
    }
    public record TokenPair(String sessionId, String accessToken, String refreshToken,
                            Instant issuedAt, Instant accessExpiresAt, Instant refreshExpiresAt, Set<String> scopes) {
        public TokenPair { scopes = Set.copyOf(scopes); }
        @Override public String toString() { return "TokenPair[sessionId=" + sessionId + ", tokens=REDACTED]"; }
    }
    public record UserPrincipal(String userId, String applicationId, String clientId, String sessionId,
                                String authenticationId, Set<String> scopes) {
        public UserPrincipal { scopes = Set.copyOf(scopes); }
    }
    private record Rotation(TokenPair tokens, Reason reason) {
        static Rotation allowed(TokenPair tokens) { return new Rotation(tokens, null); }
        static Rotation denied(Reason reason) { return new Rotation(null, reason); }
    }
}
