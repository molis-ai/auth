package ai.molis.auth.service;

import ai.molis.auth.security.TokenSecrets;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Internal service-identity lifecycle. Management methods require a separately authorized platform caller. */
@Service
public final class ServiceIdentityService {
    public static final String AUTHORIZATION_SCOPE="authorization";
    private final ServiceIdentityMapper mapper;
    private final Clock clock;
    private final TransactionTemplate transaction;
    public ServiceIdentityService(ServiceIdentityMapper mapper,Clock clock,PlatformTransactionManager manager) {
        this.mapper=mapper;this.clock=clock;transaction=new TransactionTemplate(manager);
        transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);transaction.setTimeout(10);
    }
    public Created create(String applicationId,String name,String actorUserId,String requestId) {
        return Objects.requireNonNull(transaction.execute(status->createLocked(applicationId,name,actorUserId,requestId)));
    }
    /** No claimed client identifier or presented credential is persisted on unauthenticated requests. */
    public void authenticationDenied(String requestId,String reason) {
        uuid(requestId);
        if(!Set.of("invalid_client","invalid_scope","invalid_request","rate_limited").contains(reason))
            throw new IllegalArgumentException("Invalid denial reason");
        transaction.executeWithoutResult(status->mapper.authenticationDenied(UUID.randomUUID().toString(),requestId,now(),reason));
    }
    /** Internal composition: caller must authorize the actor and retain its locks in this transaction. */
    public Created createLocked(String applicationId,String name,String actorUserId,String requestId) {
        requireTransaction();
        uuid(applicationId);uuid(actorUserId);uuid(requestId);
        if(name==null||name.isBlank()||name.length()>200)throw new IllegalArgumentException("Invalid service name");
            if(!"ACTIVE".equals(mapper.lockApplication(applicationId)))throw rejected();
            String id=UUID.randomUUID().toString(),clientId="svc_"+UUID.randomUUID();
            if(mapper.loginIdentifierCount(clientId)!=0)throw rejected();
            Instant now=now();mapper.insertClient(id,clientId,applicationId,name,now);
            var credential=newCredential(id,now);
            audit("service.client.create",actorUserId,requestId,applicationId,id,credential.id(),now);
            return new Created(id,clientId,credential.id(),credential.secret());
    }
    public Secret rotate(String clientId,String actorUserId,String requestId) {
        return Objects.requireNonNull(transaction.execute(status->rotateLocked(clientId,actorUserId,requestId)));
    }
    public Secret rotateLocked(String clientId,String actorUserId,String requestId) {
        requireTransaction();
        uuid(actorUserId);uuid(requestId);
            var client=activeClient(clientId);Instant now=now();
            mapper.revokeCredentials(client.id(),now);var credential=newCredential(client.id(),now);
            audit("service.credential.rotate",actorUserId,requestId,client.applicationId(),client.id(),credential.id(),now);
            return credential;
    }
    public void disable(String clientId,String actorUserId,String requestId) {
        transaction.executeWithoutResult(status->disableLocked(clientId,actorUserId,requestId));
    }
    public void disableLocked(String clientId,String actorUserId,String requestId) {
        requireTransaction();
        uuid(actorUserId);uuid(requestId);
            var client=activeClient(clientId);Instant now=now();mapper.disable(client.id());mapper.revokeCredentials(client.id(),now);
            audit("service.client.disable",actorUserId,requestId,client.applicationId(),client.id(),null,now);
    }
    private static void requireTransaction() {
        if(!org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive())
            throw new IllegalStateException("An authorized management transaction is required");
    }
    public Authenticated authenticate(String clientId,String rawSecret) {
        if(rawSecret==null||!rawSecret.matches("[A-Za-z0-9_-]{43}"))throw rejected();
        return Objects.requireNonNull(transaction.execute(status->{
            var client=activeClient(clientId);
            var credential=mapper.findCredential(client.id(),TokenSecrets.digest(rawSecret));
            requireCredential(client,credential);
            return new Authenticated(client.id(),client.clientId(),client.applicationId(),credential.id());
        }));
    }
    public Issued issue(Authenticated authenticated,Set<String> requestedScopes,String requestId) {
        uuid(requestId);
        var scopes=requestedScopes.isEmpty()?Set.of(AUTHORIZATION_SCOPE):Set.copyOf(requestedScopes);
        if(!scopes.equals(Set.of(AUTHORIZATION_SCOPE)))throw new Rejected(Reason.INVALID_SCOPE);
        return Objects.requireNonNull(transaction.execute(status->{
            // Authentication and token issuance are distinct framework phases. Recheck after locks.
            var client=activeClient(authenticated.clientId());
            if(!client.id().equals(authenticated.id())||!client.applicationId().equals(authenticated.applicationId()))throw rejected();
            var credential=mapper.credential(authenticated.credentialId());requireCredential(client,credential);
            Instant now=now(),expires=now.plusSeconds(300);String token=TokenSecrets.generate();
            mapper.insertToken(TokenSecrets.digest(token),credential.id(),AUTHORIZATION_SCOPE,now,expires);
            audit("service.token.issue",null,requestId,client.applicationId(),client.id(),credential.id(),now);
            return new Issued(token,now,expires,scopes);
        }));
    }
    public Optional<Principal> resolve(String rawToken) {
        if(rawToken==null||!rawToken.matches("[A-Za-z0-9_-]{43}"))return Optional.empty();
        try {
            return Objects.requireNonNull(transaction.execute(status->Optional.of(requireActiveTokenLocked(rawToken))));
        } catch(Rejected rejected){return Optional.empty();}
    }
    /** Internal transaction composition. Authorization acquires user/session locks before this service lock. */
    public Principal requireActiveTokenLocked(String rawToken) {
        if(!org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive())
            throw new IllegalStateException("An authorization transaction is required");
        if(rawToken==null||!rawToken.matches("[A-Za-z0-9_-]{43}"))throw rejected();
        String hash=TokenSecrets.digest(rawToken);var candidate=mapper.findToken(hash);
        if(candidate==null)throw rejected();
        var client=activeClient(candidate.clientId());
        var token=mapper.findToken(hash);if(token==null)throw rejected();
        var credential=mapper.credential(token.credentialId());requireCredential(client,credential);
        Instant now=now();
        if(now.isBefore(token.issuedAt())||!now.isBefore(token.expiresAt())||!AUTHORIZATION_SCOPE.equals(token.scope()))throw rejected();
        return new Principal(client.id(),client.clientId(),client.applicationId(),Set.of(token.scope()));
    }
    private ServiceIdentityMapper.Client activeClient(String clientId) {
        if(clientId==null||!clientId.matches("svc_[0-9a-f-]{36}"))throw rejected();
        var candidate=mapper.findClient(clientId);if(candidate==null)throw rejected();
        if(!"ACTIVE".equals(mapper.lockApplication(candidate.applicationId())))throw rejected();
        var client=mapper.lockClient(candidate.id());
        if(client==null||!client.clientId().equals(clientId)||!client.applicationId().equals(candidate.applicationId())
                ||!"ACTIVE".equals(client.status())||mapper.loginIdentifierCount(clientId)!=0)throw rejected();
        return client;
    }
    private static void requireCredential(ServiceIdentityMapper.Client client,ServiceIdentityMapper.Credential credential) {
        if(credential==null||!credential.serviceClientId().equals(client.id())||credential.revokedAt()!=null)throw rejected();
    }
    private Secret newCredential(String client,Instant now) {
        String id=UUID.randomUUID().toString(),secret=TokenSecrets.generate();
        mapper.insertCredential(id,client,TokenSecrets.digest(secret),now);return new Secret(id,secret);
    }
    private void audit(String action,String actor,String request,String app,String client,String credential,Instant now) {
        mapper.audit(UUID.randomUUID().toString(),action,actor,request,now,app,client,credential);
    }
    private Instant now(){return clock.instant().truncatedTo(ChronoUnit.MICROS);}
    private static void uuid(String value){UUID.fromString(value);}
    private static Rejected rejected(){return new Rejected(Reason.INVALID_CLIENT);}
    public enum Reason {INVALID_CLIENT,INVALID_SCOPE}
    public static final class Rejected extends RuntimeException {
        private final Reason reason;public Rejected(Reason reason){super(reason.name());this.reason=reason;}
        public Reason reason(){return reason;}
    }
    public record Created(String id,String clientId,String credentialId,String secret) {
        @Override public String toString(){return "Created[credentials redacted]";}
    }
    public record Secret(String id,String secret) {@Override public String toString(){return "Secret[redacted]";}}
    public record Authenticated(String id,String clientId,String applicationId,String credentialId) {}
    public record Principal(String id,String clientId,String applicationId,Set<String> scopes) {
        public Principal{scopes=Set.copyOf(scopes);}
    }
    public record Issued(String accessToken,Instant issuedAt,Instant expiresAt,Set<String> scopes) {
        public Issued{scopes=Set.copyOf(scopes);}
        @Override public String toString(){return "Issued[token redacted]";}
    }
}
