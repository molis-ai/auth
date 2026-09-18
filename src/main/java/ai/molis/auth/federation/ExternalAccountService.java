package ai.molis.auth.federation;

import ai.molis.auth.account.AccountEventMapper;
import ai.molis.auth.authorization.SpaceRole;
import ai.molis.auth.persistence.AccountMapper;
import ai.molis.auth.session.SessionLifetime;
import ai.molis.auth.session.SessionMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Internal verified-provider workflow. No HTTP mapping, no email-only linking, no local password creation. */
@Service
public final class ExternalAccountService {
    private final ExternalAccountMapper external;
    private final AccountMapper accounts;
    private final AccountEventMapper audit;
    private final SessionMapper sessions;
    private final Clock clock;
    private final TransactionTemplate writes;
    private final ai.molis.auth.session.SessionService engine;
    private final ai.molis.auth.account.AccountOperationMapper credentials;
    private final ai.molis.auth.account.PasswordHashing passwords;
    public ExternalAccountService(ExternalAccountMapper external,AccountMapper accounts,AccountEventMapper audit,
            SessionMapper sessions,Clock clock,PlatformTransactionManager manager,ai.molis.auth.session.SessionService engine,
            ai.molis.auth.account.AccountOperationMapper credentials,ai.molis.auth.account.PasswordHashing passwords) {
        this.credentials=credentials;this.passwords=passwords;
        this.engine=engine;
        this.external=external;this.accounts=accounts;this.audit=audit;this.sessions=sessions;this.clock=clock;
        writes=new TransactionTemplate(manager);writes.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        writes.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);writes.setTimeout(10);
    }
    public Result login(ProviderTokenVerifier.VerifiedIdentity identity,String locale,String requestId) {
        return loginAndPublish(identity,locale,requestId,result -> {});
    }
    BindingTarget bindingTarget(String access) {
        try { return Objects.requireNonNull(writes.execute(tx->{
            var principal=engine.requireActiveAccessLocked(access,"account");
            var target=new BindingTarget(principal.userId(),principal.sessionId(),principal.clientId());
            engine.requireRecentBindingGrantLocked(target.userId(),target.grantId(),target.clientId());
            return target;
        })); } catch(ai.molis.auth.session.SessionService.SessionRejectedException rejected) {
            throw new ai.molis.auth.login.LoginFailure(401,"UNAUTHENTICATED");
        }
    }
    /** Both target and provider proof are server-derived. Never merge accounts or reassign verified mailboxes. */
    Result bindAndPublish(ProviderTokenVerifier.VerifiedIdentity proof,BindingTarget target,String requestId,Consumer<Result> publisher) {
        Objects.requireNonNull(proof);Objects.requireNonNull(target);Objects.requireNonNull(publisher);
        if(requestId==null||!UUID.fromString(requestId).toString().equals(requestId))throw ExternalFailure.invalid();
        try { return Objects.requireNonNull(writes.execute(tx->{
            engine.requireRecentBindingGrantLocked(target.userId(),target.grantId(),target.clientId());
            var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
            if(!now.isBefore(proof.expiresAt()))throw ExternalFailure.invalid();
            var existing=external.identity(proof.issuer(),proof.subject());
            if(existing!=null&&(!existing.userId().equals(target.userId())||!existing.provider().equals(proof.provider().name())))
                throw new ai.molis.auth.login.LoginFailure(409,"IDENTITY_ALREADY_LINKED");
            // A previously consumed verification cannot reattach a subsequently unlinked identity.
            if(external.receipt(proof.verificationId())!=null)throw ExternalFailure.invalid();
            if(existing==null){
                external.insert(id(),target.userId(),proof.provider().name(),proof.issuer(),proof.subject());
                audit.audit(id(),"account.external.bind","SUCCESS",target.userId(),target.userId(),requestId,now);
            }
            var result=authenticate(proof,target.userId(),false,requestId,now);
            publisher.accept(result);return result;
        })); } catch(DuplicateKeyException conflict){throw new ai.molis.auth.login.LoginFailure(409,"IDENTITY_ALREADY_LINKED");}
    }
    public record BindingTarget(String userId,String grantId,String clientId) {}
    /** Authoritative provider mailbox selects the existing account; a correct current password proves its ownership. */
    Result linkWithPasswordAndPublish(ProviderTokenVerifier.VerifiedIdentity proof,String password,String requestId,Consumer<Result> publisher) {
        if(!proof.authoritativeEmail()||proof.email()==null)throw ExternalFailure.invalid();
        return linkWithPasswordAndPublish(proof,proof.email(),password,requestId,publisher);
    }
    /** verifiedEmail must come only from the authenticated continuation, never the HTTP body. */
    Result linkWithPasswordAndPublish(ProviderTokenVerifier.VerifiedIdentity proof,String verifiedEmail,String password,String requestId,Consumer<Result> publisher) {
        Objects.requireNonNull(proof);Objects.requireNonNull(publisher);
        if(verifiedEmail==null||requestId==null||!requestId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw ExternalFailure.invalid();
        var candidate=credentials.findCredential(verifiedEmail);
        // Expensive KDF outside locks; unknown/external-only accounts still pay the dummy KDF cost.
        boolean matched=passwords.matches(password,candidate==null?null:candidate.passwordHash());
        try {
            var result=Objects.requireNonNull(writes.execute(tx->{
                String user=candidate==null?null:candidate.userId();
                String status=user==null?null:sessions.lockUser(user);
                String hash=user==null?null:credentials.lockPassword(user);
                var owner=accounts.findByVerifiedEmail(verifiedEmail);
                var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
                if(!now.isBefore(proof.expiresAt()))throw ExternalFailure.invalid();
                boolean accepted=matched&&"ACTIVE".equals(status)&&Objects.equals(hash,candidate.passwordHash())&&owner!=null&&owner.id().equals(user);
                audit.audit(id(),"account.login",accepted?"SUCCESS":"DENIED",accepted?user:null,user,requestId,now);
                if(!accepted)return new Result(Status.DENIED,null,false);
                if(external.identity(proof.issuer(),proof.subject())!=null||external.receipt(proof.verificationId())!=null)throw ExternalFailure.invalid();
                external.insert(id(),user,proof.provider().name(),proof.issuer(),proof.subject());
                audit.audit(id(),"account.external.bind","SUCCESS",user,user,requestId,now);
                var authenticated=authenticate(proof,user,false,requestId,now);
                publisher.accept(authenticated);return authenticated;
            }));
            // Denied password audits must commit, but no binding or authentication root is issued.
            if(result.status()==Status.DENIED)throw new ai.molis.auth.login.LoginFailure(401,"INVALID_CREDENTIALS");
            return result;
        }catch(DuplicateKeyException conflict){throw new ai.molis.auth.login.LoginFailure(409,"IDENTITY_ALREADY_LINKED");}
    }
    /** A fresh second provider proof must resolve an identity already attached to the target account. */
    Result linkWithProviderAndPublish(ProviderTokenVerifier.VerifiedIdentity incoming,ProviderTokenVerifier.VerifiedIdentity existing,
            String verifiedEmail,String requestId,Consumer<Result> publisher) {
        Objects.requireNonNull(incoming);Objects.requireNonNull(existing);Objects.requireNonNull(publisher);
        if(verifiedEmail==null||requestId==null||!requestId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw ExternalFailure.invalid();
        try{return Objects.requireNonNull(writes.execute(tx->{
            var owner=accounts.findByVerifiedEmail(verifiedEmail);
            if(owner==null||!"ACTIVE".equals(sessions.lockUser(owner.id())))throw new ai.molis.auth.login.LoginFailure(401,"INVALID_CREDENTIALS");
            var current=accounts.findByVerifiedEmail(verifiedEmail);
            var bound=external.identity(existing.issuer(),existing.subject());
            var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
            if(current==null||!current.id().equals(owner.id())||bound==null||!bound.userId().equals(owner.id())||!bound.provider().equals(existing.provider().name()))
                throw new ai.molis.auth.login.LoginFailure(401,"INVALID_CREDENTIALS");
            if(!now.isBefore(incoming.expiresAt())||!now.isBefore(existing.expiresAt())||incoming.verificationId().equals(existing.verificationId())
                    ||external.receipt(incoming.verificationId())!=null||external.receipt(existing.verificationId())!=null
                    ||external.identity(incoming.issuer(),incoming.subject())!=null)throw ExternalFailure.invalid();
            external.insert(id(),owner.id(),incoming.provider().name(),incoming.issuer(),incoming.subject());
            if(!clock.instant().isBefore(existing.expiresAt()))throw ExternalFailure.invalid();
            audit.audit(id(),"account.external.bind","SUCCESS",owner.id(),owner.id(),requestId,now);
            var result=authenticate(incoming,owner.id(),false,requestId,now);
            external.receiptInsert(existing.verificationId(),existing.issuer(),existing.subject(),owner.id(),result.authenticationId(),false,now);
            publisher.accept(result);return result;
        }));}catch(DuplicateKeyException conflict){throw new ai.molis.auth.login.LoginFailure(409,"IDENTITY_ALREADY_LINKED");}
    }
    /** Internal continuation only. Both capabilities must be verified; a mailbox is never account reauthentication. */
    Result registerWithMailboxAndPublish(ProviderTokenVerifier.VerifiedIdentity identity,
            ai.molis.auth.verification.RedisMailboxProofs.VerifiedMailbox mailbox,String locale,String requestId,Consumer<Result> publisher) {
        Objects.requireNonNull(identity);Objects.requireNonNull(mailbox);Objects.requireNonNull(publisher);
        if (mailbox.purpose()!=ai.molis.auth.verification.RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY
                || requestId==null || !requestId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw ExternalFailure.invalid();
        try { return Objects.requireNonNull(writes.execute(tx -> {
            var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
            if (!now.isBefore(identity.expiresAt()) || external.receipt(identity.verificationId())!=null
                    || external.identity(identity.issuer(),identity.subject())!=null) throw ExternalFailure.invalid();
            external.mailboxReceipt(mailbox.operationId(),identity.verificationId(),now);
            // Keep a durable consumed receipt even for a conflict: mailbox ownership is not account ownership.
            if (accounts.findByVerifiedEmail(mailbox.email())!=null)
                return new Result(Status.ACCOUNT_LINK_REQUIRED,null,false);
            var result=register(identity,mailbox.email(),locale,requestId,now);
            publisher.accept(result);
            return result;
        })); } catch (DuplicateKeyException conflict) {
            // Never replay a provider exchange or restore a Redis mailbox capability after an uncertain outcome.
            throw ExternalFailure.invalid();
        }
    }
    /** Internal coordinator hook: publish only verified roots, inside the transaction before commit. */
    Result loginAndPublish(ProviderTokenVerifier.VerifiedIdentity identity,String locale,String requestId,Consumer<Result> publisher) {
        Objects.requireNonNull(identity);
        Objects.requireNonNull(publisher);
        if(requestId==null||!requestId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw ExternalFailure.invalid();
        // Retry only a fully rolled-back DB uniqueness race, never a provider code/token exchange.
        for(int attempt=0;attempt<2;attempt++) {
            boolean[] publicationAttempted = {false};
            try {
                var result=Objects.requireNonNull(writes.execute(tx -> {
                    var candidate = execute(identity,locale,requestId);
                    if (candidate.status() == Status.AUTHENTICATED) {
                        publicationAttempted[0] = true;
                        publisher.accept(candidate);
                    }
                    return candidate;
                }));
                if(result.status()==Status.DENIED) throw new ExternalFailure("INVALID_CREDENTIALS");
                return result;
            } catch(DuplicateKeyException race) { if(attempt==1 || publicationAttempted[0]) throw new ExternalFailure("AUTH_UNAVAILABLE"); }
        }
        throw new ExternalFailure("AUTH_UNAVAILABLE");
    }
    private Result execute(ProviderTokenVerifier.VerifiedIdentity proof,String locale,String request) {
        var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
        if(!now.isBefore(proof.expiresAt())) throw ExternalFailure.invalid();
        var receipt=external.receipt(proof.verificationId());
        if(receipt!=null) return receipt(proof,receipt,now);
        var identity=external.identity(proof.issuer(),proof.subject());
        if(identity!=null) {
            if(!"ACTIVE".equals(sessions.lockUser(identity.userId()))) {
                audit.audit(id(),"account.external.login","DENIED",null,identity.userId(),request,now);
                return new Result(Status.DENIED,null,false);
            }
            // Recheck after serialization with disable/unlink/reset and concurrent proof consumption.
            var current=external.identity(proof.issuer(),proof.subject());
            if(current==null||!current.equals(identity)||!identity.provider().equals(proof.provider().name())) throw ExternalFailure.invalid();
            receipt=external.receipt(proof.verificationId());
            if(receipt!=null) return receipt(proof,receipt,now);
            return authenticate(proof,identity.userId(),false,request,now);
        }
        if(!proof.authoritativeEmail()) return new Result(Status.MAILBOX_VERIFICATION_REQUIRED,null,false);
        // Possession of a provider identity is not proof of an existing local/other-provider account.
        if(accounts.findByVerifiedEmail(proof.email())!=null) return new Result(Status.ACCOUNT_LINK_REQUIRED,null,false);
        return register(proof,proof.email(),locale,request,now);
    }
    private Result register(ProviderTokenVerifier.VerifiedIdentity proof,String verifiedEmail,String locale,String request,Instant now) {
        String user=id(),space=id();
        accounts.insertUser(user,proof.displayName());
        accounts.insertVerifiedEmail(id(),user,verifiedEmail);
        accounts.insertPersonalSpace(space,user,"en".equals(locale)?"Personal space":"个人空间");
        accounts.insertMembership(space,user,SpaceRole.OWNER);
        external.insert(id(),user,proof.provider().name(),proof.issuer(),proof.subject());
        audit.audit(id(),"account.external.register","SUCCESS",user,user,request,now);
        audit.mail(id(),verifiedEmail,"ACCOUNT_REGISTERED","en".equals(locale)?"en":"zh-CN",now);
        return authenticate(proof,user,true,request,now);
    }
    private Result authenticate(ProviderTokenVerifier.VerifiedIdentity proof,String user,boolean registered,String request,Instant now) {
        // Recheck after potentially waiting on user/unique-key locks; expired proof cannot issue a root.
        now=clock.instant().truncatedTo(ChronoUnit.MICROS);
        if(!now.isBefore(proof.expiresAt())) throw ExternalFailure.invalid();
        String root=id();sessions.insertAuthentication(root,user,null,now);
        external.receiptInsert(proof.verificationId(),proof.issuer(),proof.subject(),user,root,registered,now);
        audit.audit(id(),"account.external.login","SUCCESS",user,user,request,now);
        return new Result(Status.AUTHENTICATED,root,registered);
    }
    private Result receipt(ProviderTokenVerifier.VerifiedIdentity proof,ExternalAccountMapper.Receipt receipt,Instant now) {
        if(!receipt.issuer().equals(proof.issuer())||!receipt.subject().equals(proof.subject())) throw ExternalFailure.invalid();
        if(!"ACTIVE".equals(sessions.lockUser(receipt.userId()))) throw new ExternalFailure("INVALID_CREDENTIALS");
        var identity=external.identity(proof.issuer(),proof.subject());
        if(identity==null||!identity.userId().equals(receipt.userId())||!identity.provider().equals(proof.provider().name())) throw ExternalFailure.invalid();
        var root=sessions.lockAuthentication(receipt.authenticationId());
        now=clock.instant().truncatedTo(ChronoUnit.MICROS);
        if(!now.isBefore(proof.expiresAt())) throw ExternalFailure.invalid();
        if(root==null||!root.userId().equals(receipt.userId())||root.revokedAt()!=null||!new SessionLifetime(root.authenticatedAt(),root.lastUserActivityAt()).isActiveAt(now))
            throw new ExternalFailure("INVALID_CREDENTIALS");
        return new Result(Status.AUTHENTICATED,root.id(),receipt.registered());
    }
    private static String id(){return UUID.randomUUID().toString();}
    public enum Status { AUTHENTICATED, ACCOUNT_LINK_REQUIRED, MAILBOX_VERIFICATION_REQUIRED, DENIED }
    public record Result(Status status,String authenticationId,boolean registered) {}
}
