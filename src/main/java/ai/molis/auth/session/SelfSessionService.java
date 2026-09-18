package ai.molis.auth.session;

import ai.molis.auth.login.LoginClientPolicy;
import ai.molis.auth.login.LoginFailure;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** User-owned account operations only, not a resource authorizer or service-token API. */
@Service
@ConditionalOnProperty(name="auth.login.enabled", havingValue="true")
public final class SelfSessionService {
    private final SessionService engine;
    private final SessionMapper sessions;
    private final SelfSessionMapper accounts;
    private final SelfSecurityMapper security;
    private final LoginClientPolicy policy;
    private final Clock clock;
    private final TransactionTemplate writes;
    private final org.springframework.beans.factory.ObjectProvider<ai.molis.auth.federation.ProviderConfiguration.ProviderClients> providers;
    public SelfSessionService(SessionService engine, SessionMapper sessions, SelfSessionMapper accounts, SelfSecurityMapper security,
            LoginClientPolicy policy, Clock clock, PlatformTransactionManager manager,
            org.springframework.beans.factory.ObjectProvider<ai.molis.auth.federation.ProviderConfiguration.ProviderClients> providers) {
        this.providers=providers;
        this.engine=engine; this.sessions=sessions; this.accounts=accounts; this.security=security; this.policy=policy; this.clock=clock;
        writes=new TransactionTemplate(manager);
        writes.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        writes.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED); writes.setTimeout(10);
    }
    public Me me(String access, String origin) {
        return Objects.requireNonNull(writes.execute(status -> {
            var user=authorize(access,origin);
            return new Me(user.userId(),accounts.displayName(user.userId()),accounts.emails(user.userId()),
                    user.applicationId(),user.clientId(),user.sessionId(),user.scopes(),accounts.avatar(user.userId()));
        }));
    }
    public Me updateProfile(String access,String origin,String name,String avatar,String requestId) {
        return Objects.requireNonNull(writes.execute(status -> {
            var user = authorize(access,origin);
            var checkedName = ProfileInput.name(name);
            var checkedAvatar = ProfileInput.avatar(avatar);
            accounts.updateProfile(user.userId(),checkedName,checkedAvatar);
            accounts.audit(UUID.randomUUID().toString(),"account.profile.update",user.userId(),requestId,
                    clock.instant(),user.applicationId(),user.sessionId());
            return new Me(user.userId(),checkedName,accounts.emails(user.userId()),user.applicationId(),
                    user.clientId(),user.sessionId(),user.scopes(),checkedAvatar);
        }));
    }
    public Object loginMethods(String access,String origin) {
        return writes.execute(status->{var user=authorize(access,origin);var enabled=enabledProviders();
            return java.util.Map.of("userId",user.userId(),"availableProviders",enabled.stream().sorted().toList(),"password",security.localMethods(user.userId())>0,"external",security.externalMethods(user.userId()).stream()
                .map(method->java.util.Map.of("id",method.id(),"provider",method.provider(),"available",enabled.contains(method.provider().toLowerCase(java.util.Locale.ROOT)))).toList());});
    }
    public Object unlink(String access,String origin,String id,String requestId) {
        uuid(id);uuid(requestId);
        return writes.execute(status->{
            var user=authorize(access,origin); // Serializes all login-method mutations on the user lock.
            var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
            var authenticated=security.authenticationTime(user.userId(),user.authenticationId());
            if(authenticated==null||authenticated.isAfter(now)||!now.isBefore(authenticated.plusSeconds(300)))
                throw new LoginFailure(403,"REAUTHENTICATION_REQUIRED");
            var methods=security.externalMethods(user.userId());
            if(methods.stream().noneMatch(method->method.id().equals(id)))throw new LoginFailure(404,"LOGIN_METHOD_NOT_FOUND");
            var enabled=enabledProviders();
            boolean remaining=security.localMethods(user.userId())>0||methods.stream().anyMatch(method->!method.id().equals(id)
                    &&enabled.contains(method.provider().toLowerCase(java.util.Locale.ROOT)));
            if(!remaining)throw new LoginFailure(409,"LAST_LOGIN_METHOD");
            if(security.unlink(user.userId(),id)!=1)throw new LoginFailure(409,"LOGIN_METHOD_NOT_FOUND");
            sessions.revokeUserAuthentications(user.userId(),now);sessions.revokeUserGrants(user.userId(),now);
            accounts.audit(UUID.randomUUID().toString(),"account.external.unlink",user.userId(),requestId,now,user.applicationId(),user.sessionId());
            return java.util.Map.of("unlinked",true,"loggedOut",true);
        });
    }
    private Set<String> enabledProviders(){var configured=providers.getIfAvailable();return configured==null?Set.of():Set.copyOf(configured.enabledProviders());}
    public void logout(String access, String origin, boolean all, String requestId) {
        String request=UUID.fromString(requestId).toString();
        writes.executeWithoutResult(status -> {
            var user=authorize(access,origin);
            var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
            if (all) {
                sessions.revokeUserAuthentications(user.userId(),now);
                sessions.revokeUserGrants(user.userId(),now);
            } else sessions.revokeGrant(user.sessionId(),now);
            // Same transaction: an audit write failure cannot report a successful unaudited logout.
            accounts.audit(UUID.randomUUID().toString(),all?"session.logout.all":"session.logout.current",user.userId(),
                    request,now,user.applicationId(),user.sessionId());
        });
    }
    private SessionService.UserPrincipal authorize(String access, String origin) {
        var user=engine.requireActiveAccessLocked(access,"account");
        policy.requireUserClientOrigin(user.clientId(),origin);
        return user;
    }
    public Page<AuthenticationView> authentications(String access,String origin,String cursor,int limit) {
        pageArgs(cursor,limit);
        return Objects.requireNonNull(writes.execute(status -> {
            var user=authorize(access,origin);
            var time=cursor==null?null:security.authenticationTime(user.userId(),cursor);
            if(cursor!=null&&time==null) throw new LoginFailure(400,"INVALID_REQUEST");
            String current=sessions.findGrant(user.sessionId()).authenticationId();
            var now=clock.instant();
            var rows=security.authentications(user.userId(),time,cursor,limit+1);
            var items=rows.stream().limit(limit).map(row -> {
                var lifetime=new SessionLifetime(row.authenticatedAt(),row.lastUserActivityAt());
                return new AuthenticationView(row.id(),row.id().equals(current),row.authenticatedAt(),row.lastUserActivityAt(),
                        lifetime.expiresAt(),row.revokedAt(),row.revokedAt()!=null?"REVOKED":lifetime.isActiveAt(now)?"ACTIVE":"EXPIRED",row.applicationSessionCount());
            }).toList();
            return new Page<>(items,rows.size()>limit?items.getLast().id():null);
        }));
    }
    public Revocation revokeAuthentication(String access,String origin,String id,String requestId) {
        uuid(id);
        return Objects.requireNonNull(writes.execute(status -> {
            var user=authorize(access,origin); // Holds the user lock before any target root/child locks.
            // Read ownership first: never lock another user's root while holding our own user lock.
            if(security.authenticationTime(user.userId(),id)==null || security.lockOwnedAuthentication(user.userId(),id)==null)
                throw new LoginFailure(404,"SESSION_NOT_FOUND");
            boolean current=sessions.findGrant(user.sessionId()).authenticationId().equals(id);
            var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
            int changed=security.revokeAuthentication(user.userId(),id,now);
            security.revokeChildren(user.userId(),id,now);
            if(changed>0) security.auditRevocation(UUID.randomUUID().toString(),user.userId(),UUID.fromString(requestId).toString(),
                    now,user.applicationId(),user.sessionId(),id);
            return new Revocation(true,current);
        }));
    }
    public Page<SelfSecurityMapper.Event> securityEvents(String access,String origin,String cursor,int limit) {
        pageArgs(cursor,limit);
        return Objects.requireNonNull(writes.execute(status -> {
            var user=authorize(access,origin);
            var time=cursor==null?null:security.eventTime(user.userId(),cursor);
            if(cursor!=null&&time==null) throw new LoginFailure(400,"INVALID_REQUEST");
            var rows=security.events(user.userId(),time,cursor,limit+1);
            var items=rows.stream().limit(limit).toList();
            return new Page<>(items,rows.size()>limit?items.getLast().id():null);
        }));
    }
    private static void pageArgs(String cursor,int limit) {
        if(cursor!=null) uuid(cursor);
        if(limit<1||limit>200) throw new LoginFailure(400,"INVALID_REQUEST");
    }
    private static void uuid(String value) {
        if(value==null||!value.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw new LoginFailure(400,"INVALID_REQUEST");
    }
    public record Page<T>(List<T> items,String nextCursor) { public Page { items=List.copyOf(items); } }
    public record AuthenticationView(String id,boolean current,Instant authenticatedAt,Instant lastUserActivityAt,
            Instant expiresAt,Instant revokedAt,String status,long applicationSessionCount) {}
    public record Revocation(boolean revoked,boolean current) {}
    public record Me(String userId,String displayName,List<String> emails,String applicationId,String clientId,String sessionId,Set<String> scopes,String avatarUrl) {
        public Me { emails=List.copyOf(emails); scopes=Set.copyOf(scopes); }
    }
}
