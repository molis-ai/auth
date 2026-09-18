package ai.molis.auth.space;

import ai.molis.auth.account.EmailAddress;
import ai.molis.auth.authorization.*;
import ai.molis.auth.login.*;
import ai.molis.auth.mail.MailOutboxMapper;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.*;
import ai.molis.auth.verification.RedisRateLimiter;
import java.time.Instant;
import java.util.*;
import java.util.function.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.*;
import org.springframework.transaction.support.TransactionTemplate;
import static ai.molis.auth.authorization.SpaceRole.*;

/** Auth-owned global space management, distinct from backend dual-identity business-resource authorization. */
@Service
@ConditionalOnProperty(name="auth.login.enabled",havingValue="true")
public final class SpaceService {
    private final ai.molis.auth.platform.PlatformAdministrators administrators;
    private final SpaceMapper mapper;
    private final SessionMapper sessionRows;
    private final SessionService sessions;
    private final LoginClientPolicy origins;
    private final MailOutboxMapper mail;
    private final ObjectProvider<RedisRateLimiter> limiter;
    private final TransactionTemplate transaction;
    private final MembershipPolicy policy=new MembershipPolicy();
    public SpaceService(SpaceMapper mapper,SessionMapper sessionRows,SessionService sessions,LoginClientPolicy origins,MailOutboxMapper mail,
            ObjectProvider<RedisRateLimiter> limiter,PlatformTransactionManager manager,ai.molis.auth.platform.PlatformAdministrators administrators){
        this.administrators=administrators;
        this.mapper=mapper;this.sessionRows=sessionRows;this.sessions=sessions;this.origins=origins;this.mail=mail;this.limiter=limiter;
        transaction=new TransactionTemplate(manager);transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);transaction.setTimeout(10);
    }
    public Object spaces(Caller caller,String cursor,int limit){pageArgs(cursor,limit);return run(caller,null,"space.list",List::of,user->page(mapper.spaces(user.userId(),cursor(cursor),limit+1),limit,SpaceMapper.View::id));}
    public Object teams(Caller caller,String query,String status,String order,String cursor,int limit){
        var filter=TeamQuery.parse(query,status,order,cursor,limit);
        return run(caller,null,"space.list",List::of,user->page(mapper.teams(user.userId(),administrators.contains(user.userId()),filter,limit+1),limit,TeamQuery::cursor));
    }
    public Object create(Caller caller,String name,String description,String avatar){name(name);
        if(description==null||description.codePointCount(0,description.length())>200||description.codePoints().anyMatch(c->Character.isISOControl(c)&&c!='\n'&&c!='\r'))throw new SpaceFailure(400,"INVALID_TEAM_DESCRIPTION");
        return run(caller,null,"space.create",List::of,user->{
        String safeAvatar;try{safeAvatar=ProfileInput.avatar(avatar);}catch(LoginFailure invalidAvatar){throw new SpaceFailure(400,"INVALID_AVATAR");}
        rate(RedisRateLimiter.Bucket.SPACE_CREATE_USER,user.userId());String space=id();mapper.create(space,name);mapper.add(space,user.userId(),OWNER);
        mapper.profile(space,description.strip(),safeAvatar);
        audit(caller,user,"space.create",space,user.userId(),null,"OWNER created atomically");return view(member(space,user.userId()));});}
    public Object detail(Caller caller,String space){uuid(space);return run(caller,space,"space.read",List::of,user->view(readableTeamProfile(space,user.userId())));}
    public Object update(Caller caller,String space,String name,long version){uuid(space);name(name);version(version);return run(caller,space,"space.update",List::of,user->{
        var context=member(space,user.userId());require(!personal(context)&&!archived(context)&&(context.role()==OWNER||context.role()==ADMIN));match(context.space().version(),version);
        mapper.update(space,name,context.space().status());audit(caller,user,"space.update",space,null,null,"version="+(version+1));return view(member(space,user.userId()));});}
    public Object archive(Caller caller,String space,boolean archived,long version){uuid(space);version(version);return run(caller,space,archived?"space.archive":"space.restore",List::of,user->{
        var context=member(space,user.userId());require(!personal(context)&&context.role()==OWNER);match(context.space().version(),version);
        mapper.update(space,context.space().name(),archived?"ARCHIVED":"ACTIVE");audit(caller,user,archived?"space.archive":"space.restore",space,null,null,"version="+(version+1));return view(member(space,user.userId()));});}
    public Object updateProfile(Caller caller,String space,String name,String description,String avatar,long version){
        uuid(space);name(name);version(version);
        if(description==null||description.codePointCount(0,description.length())>200||description.codePoints().anyMatch(c->Character.isISOControl(c)&&c!='\n'&&c!='\r'))throw new SpaceFailure(400,"INVALID_TEAM_DESCRIPTION");
        return run(caller,space,"space.update",List::of,user->{
            var context=member(space,user.userId());require(!personal(context)&&!archived(context)&&(context.role()==OWNER||context.role()==ADMIN));match(context.space().version(),version);
            String safeAvatar;try{safeAvatar=ProfileInput.avatar(avatar);}catch(LoginFailure invalidAvatar){throw new SpaceFailure(400,"INVALID_AVATAR");}
            mapper.update(space,name,context.space().status());mapper.profile(space,description.strip(),safeAvatar);
            audit(caller,user,"space.update",space,null,null,"profile updated; version="+(version+1));return view(member(space,user.userId()));
        });
    }
    public Object inviteCandidates(Caller caller,String space,String query){
        uuid(space);if(query==null||query.strip().length()<2||query.length()>254||query.codePoints().anyMatch(Character::isISOControl))throw invalid();
        return run(caller,space,"space.invitation.search",List::of,user->{
            var context=member(space,user.userId());require(policy.canInvite(context.role(),archived(context),personal(context)));
            rate(RedisRateLimiter.Bucket.SPACE_SEARCH_USER,user.userId());return mapper.inviteCandidates(space,query.strip());
        });
    }
    public Object members(Caller caller,String space,String cursor,int limit){uuid(space);pageArgs(cursor,limit);return run(caller,space,"space.member.read",List::of,user->{
        readableTeamProfile(space,user.userId());return page(mapper.members(space,cursor(cursor),limit+1),limit,SpaceMapper.Member::id);});}
    public Object memberDirectory(Caller caller,String space,String query,int requestedPage,int limit,String sort,String order){
        uuid(space);String search=query==null?"":query.strip();
        final String sortField=sort==null?"role":sort, direction=order==null?"desc":order;
        if(!Set.of("name","role").contains(sortField)||!Set.of("asc","desc").contains(direction))throw invalid();
        if(requestedPage<1||requestedPage>1000000||limit<1||limit>100||search.length()>254||search.codePoints().anyMatch(Character::isISOControl))throw invalid();
        return run(caller,space,"space.member.read",List::of,user->{
            var context=readableTeamProfile(space,user.userId());long total=mapper.filteredMemberCount(space,search);
            int current=(int)Math.min(requestedPage,Math.max(1,(total+limit-1)/limit));
            var fixed=new FixedPermissionPolicy();var permissions=new EnumMap<SpaceRole,MemberPermissions>(SpaceRole.class);
            for(var role:SpaceRole.values())permissions.put(role,new MemberPermissions(
                List.copyOf(fixed.allowedActions(role,archived(context),personal(context))),
                policy.canInvite(role,archived(context),personal(context)),
                Arrays.stream(SpaceRole.values()).filter(target->Arrays.stream(SpaceRole.values()).anyMatch(replacement->policy.canChangeRole(role,target,replacement,archived(context),personal(context)))).toList(),
                Arrays.stream(SpaceRole.values()).filter(target->policy.canRemove(role,target,personal(context))).toList()));
            var items=mapper.memberDirectory(space,search,limit,(long)(current-1)*limit,sortField,direction).stream()
                .map(m->new DirectoryMember(m.id(),m.displayName(),m.status(),m.role(),mapper.emails(m.id()),permissions.get(m.role()))).toList();
            return new MemberPage(items,total,current,limit);
        });
    }
    public record MemberPermissions(List<String> actions,boolean invite,List<SpaceRole> editableRoles,List<SpaceRole> removableRoles){}
    public record DirectoryMember(String id,String displayName,String status,SpaceRole role,List<String> emails,MemberPermissions permissions){}
    public record MemberPage(List<DirectoryMember> items,long total,int page,int pageSize){}
    public Object role(Caller caller,String space,String target,SpaceRole replacement){uuid(space);uuid(target);if(replacement==null)throw invalid();return run(caller,space,"space.member.role",()->List.of(target),user->{
        var context=member(space,user.userId());var current=mapper.role(space,target);
        require(policy.canChangeRole(context.role(),current,replacement,archived(context),personal(context)));
        if(!"ACTIVE".equals(mapper.userStatus(target)))throw new SpaceFailure(409,"TARGET_INACTIVE");
        mapper.changeRole(space,target,replacement);mapper.changed(space);audit(caller,user,"space.member.role",space,target,null,current+"->"+replacement);return Map.of("role",replacement);});}
    public Object remove(Caller caller,String space,String target){uuid(space);uuid(target);return run(caller,space,"space.member.remove",()->List.of(target),user->{
        var context=member(space,user.userId());var current=mapper.role(space,target);require(policy.canRemove(context.role(),current,personal(context)));
        mapper.remove(space,target);mapper.changed(space);audit(caller,user,"space.member.remove",space,target,null,"membership removed; data retained");return Map.of("removed",true);});}
    public Object leave(Caller caller,String space){uuid(space);return run(caller,space,"space.member.leave",List::of,user->{
        var context=member(space,user.userId());require(policy.canLeave(context.role(),personal(context)));
        mapper.remove(space,user.userId());mapper.changed(space);audit(caller,user,"space.member.leave",space,user.userId(),null,"membership removed; data retained");return Map.of("left",true);});}
    public Object invite(Caller caller,String space,String emailInput,String locale){uuid(space);String email=EmailAddress.canonicalize(emailInput);
        return run(caller,space,"space.invitation.create",List::of,user->{var context=member(space,user.userId());require(policy.canInvite(context.role(),archived(context),personal(context)));
            String recipient=mapper.invitationRecipient(email);
            if(recipient==null)throw new SpaceFailure(400,"INVITEE_NOT_REGISTERED");
            Instant now=mapper.now();var pending=mapper.pendingInvite(space,email);
            if(pending!=null&&recipient.equals(pending.recipientUserId())&&now.isBefore(pending.expiresAt()))return invitationView(pending);
            if(pending!=null){mapper.invitationStatus(pending.id(),"EXPIRED",null);audit(caller,user,"space.invitation.expire",space,null,pending.id(),"expired");}
            rate(RedisRateLimiter.Bucket.SPACE_INVITE_USER,user.userId());rate(RedisRateLimiter.Bucket.MAIL_EMAIL,email);
            var invitation=new SpaceMapper.Invitation(id(),space,email,user.userId(),"PENDING",null,now,now.plusSeconds(7*86400),recipient);mapper.invite(invitation);
            // In-app delivery is account-bound and does not depend on mailbox verification or SMTP.
            audit(caller,user,"space.invitation.create",space,null,invitation.id(),"pending; initial role=MEMBER");return invitationView(invitation);});}
    public Object invitations(Caller caller,String cursor,int limit){pageArgs(cursor,limit);return run(caller,null,"space.invitation.inbox",List::of,user->
        page(mapper.inbox(user.userId(),cursor(cursor),limit+1).stream().map(this::invitationView).toList(),limit,InvitationView::id));}
    public Object spaceInvitations(Caller caller,String space,String cursor,int limit){uuid(space);pageArgs(cursor,limit);return run(caller,space,"space.invitation.list",List::of,user->{
        var context=readableTeamProfile(space,user.userId());require(!personal(context)&&(context.platformAdmin()||context.role()==OWNER||context.role()==ADMIN));
        return page(mapper.spaceInvitations(space,cursor(cursor),limit+1).stream().map(this::invitationView).toList(),limit,InvitationView::id);});}
    public Object invitationDirectory(Caller caller,String space,int requestedPage,int limit){
        uuid(space);if(requestedPage<1||requestedPage>1000000||limit<1||limit>100)throw invalid();
        return run(caller,space,"space.invitation.list",List::of,user->{
            var context=readableTeamProfile(space,user.userId());require(!personal(context)&&(context.platformAdmin()||context.role()==OWNER||context.role()==ADMIN));
            long total=mapper.invitationCount(space);int current=(int)Math.min(requestedPage,Math.max(1,(total+limit-1)/limit));
            return new InvitationDirectory(mapper.invitationDirectory(space,limit,(long)(current-1)*limit).stream().map(this::invitationView).toList(),total,current,limit);
        });
    }
    public record InvitationDirectory(List<InvitationView> items,long total,int page,int pageSize){}
    public Object invitation(Caller caller,String id){uuid(id);return run(caller,null,"space.invitation.read",List::of,user->{
        var value=required(mapper.invitation(id));recipient(value,user.userId());return invitationView(value);});}
    public Object answer(Caller caller,String id,boolean accept){uuid(id);String action=accept?"space.invitation.accept":"space.invitation.decline";
        return run(caller,null,action,()->{var value=mapper.invitation(id);return value==null?List.of():List.of(value.inviterUserId());},user->{
            var candidate=required(mapper.invitation(id));var space=required(mapper.lock(candidate.spaceId()));var invitation=required(mapper.invitation(id));recipient(invitation,user.userId());
            if(accept&&"ACCEPTED".equals(invitation.status())&&user.userId().equals(invitation.acceptedBy()))return invitationView(invitation);
            if(!accept&&"DECLINED".equals(invitation.status()))return invitationView(invitation);
            requirePending(invitation,caller,user);
            if(accept){
                var inviter=mapper.role(space.id(),invitation.inviterUserId());
                require("ACTIVE".equals(mapper.userStatus(invitation.inviterUserId()))&&policy.canInvite(inviter,"ARCHIVED".equals(space.status()),"PERSONAL".equals(space.spaceType())));
                if(mapper.role(space.id(),user.userId())==null){mapper.add(space.id(),user.userId(),MEMBER);mapper.changed(space.id());}
                // Existing members keep their role; replay after later removal must never add membership again.
                mapper.invitationStatus(id,"ACCEPTED",user.userId());
            }else mapper.invitationStatus(id,"DECLINED",null);
            audit(caller,user,action,space.id(),user.userId(),id,accept?"accepted; existing role preserved":"declined");return invitationView(mapper.invitation(id));});}
    public Object revoke(Caller caller,String space,String id){uuid(space);uuid(id);return run(caller,space,"space.invitation.revoke",List::of,user->{
        var context=member(space,user.userId());require(!personal(context)&&(context.role()==OWNER||context.role()==ADMIN));var invitation=required(mapper.invitation(id));
        if(!space.equals(invitation.spaceId()))throw new SpaceFailure(404,"NOT_FOUND");
        if("REVOKED".equals(invitation.status()))return invitationView(invitation);requirePending(invitation,caller,user);
        mapper.invitationStatus(id,"REVOKED",null);audit(caller,user,"space.invitation.revoke",space,null,id,"revoked");return invitationView(mapper.invitation(id));});}
    public Object auditEvents(Caller caller,String space,String cursor,int limit){uuid(space);pageArgs(cursor,limit);return run(caller,space,"space.audit.read",List::of,user->{
        var context=readableTeamProfile(space,user.userId());require(context.platformAdmin()||context.role()==OWNER||context.role()==ADMIN);
        Instant time=cursor==null?null:mapper.auditTime(cursor,space);if(cursor!=null&&time==null)throw invalid();
        var names=new HashMap<String,String>();
        return page(mapper.auditPage(space,time,cursor,limit+1).stream().map(a->new AuditView(a.id(),a.action(),a.outcome(),a.actorUserId(),a.targetUserId(),a.spaceId(),a.requestId(),a.occurredAt(),a.invitationId(),a.changeSummary(),a.denialReason(),a.actorUserId()==null?null:names.computeIfAbsent(a.actorUserId(),mapper::userName),a.targetUserId()==null?null:names.computeIfAbsent(a.targetUserId(),mapper::userName))).toList(),limit,AuditView::id);});}
    public Object auditDirectory(Caller caller,String space,int requestedPage,int limit){
        uuid(space);if(requestedPage<1||requestedPage>1000000||limit<1||limit>100)throw invalid();
        return run(caller,space,"space.audit.read",List::of,user->{
            var context=readableTeamProfile(space,user.userId());require(context.platformAdmin()||context.role()==OWNER||context.role()==ADMIN);
            long total=mapper.auditCount(space);int current=(int)Math.min(requestedPage,Math.max(1,(total+limit-1)/limit));
            var names=new HashMap<String,String>();
            var items=mapper.auditDirectory(space,limit,(long)(current-1)*limit).stream().map(a->new AuditView(a.id(),a.action(),a.outcome(),a.actorUserId(),a.targetUserId(),a.spaceId(),a.requestId(),a.occurredAt(),a.invitationId(),a.changeSummary(),a.denialReason(),a.actorUserId()==null?null:names.computeIfAbsent(a.actorUserId(),mapper::userName),a.targetUserId()==null?null:names.computeIfAbsent(a.targetUserId(),mapper::userName))).toList();
            return new AuditDirectory(items,total,current,limit);
        });
    }
    public record AuditDirectory(List<AuditView> items,long total,int page,int pageSize){}
    public record AuditView(String id,String action,String outcome,String actorUserId,String targetUserId,String spaceId,String requestId,Instant occurredAt,String invitationId,String changeSummary,String denialReason,String actorName,String targetName){}

    private Object run(Caller caller,String space,String action,Supplier<List<String>> participants,Function<SessionService.UserPrincipal,Object> work){
        uuid(caller.requestId());var result=Objects.requireNonNull(transaction.execute(status->{SessionService.UserPrincipal user=null;
            try{
                if(caller.access()!=null&&caller.access().matches("[A-Za-z0-9_-]{43}")){
                    var candidate=sessionRows.findAccess(TokenSecrets.digest(caller.access()));
                    if(candidate!=null){var ids=new TreeSet<>(participants.get());ids.add(candidate.userId());for(String id:ids)sessionRows.lockUser(id);}
                }
                user=sessions.requireActiveAccessLocked(caller.access(),"account");origins.requireUserClientOrigin(user.clientId(),caller.origin());
                return new Result(work.apply(user),null);
            }catch(SessionService.SessionRejectedException rejected){return denied(caller,user,space,action,new SpaceFailure(rejected.reason()==SessionService.Reason.INVALID_SCOPE?403:401,rejected.reason()==SessionService.Reason.INVALID_SCOPE?"ACCOUNT_SCOPE_REQUIRED":"UNAUTHENTICATED"));}
            catch(LoginFailure rejected){return denied(caller,user,space,action,new SpaceFailure(rejected.status(),rejected.getMessage()));}
            catch(SpaceFailure rejected){return denied(caller,user,space,action,rejected);}
        }));if(result.failure()!=null)throw result.failure();return result.value();
    }
    private Result denied(Caller caller,SessionService.UserPrincipal user,String space,String action,SpaceFailure failure){
        mapper.audit(new SpaceMapper.Audit(id(),action,"DENIED",user==null?null:user.userId(),null,space,caller.requestId(),mapper.now(),null,null,failure.getMessage()));return new Result(null,failure);}
    private void audit(Caller caller,SessionService.UserPrincipal user,String action,String space,String target,String invitation,String summary){
        mapper.audit(new SpaceMapper.Audit(id(),action,"SUCCESS",user.userId(),target,space,caller.requestId(),mapper.now(),invitation,summary,null));}
    // Platform administrators can read team management data. Write endpoints continue to require actual membership.
    private Context readableTeamProfile(String id,String user){
        if(!administrators.contains(user))return member(id,user);
        var space=mapper.lock(id);
        if(space==null||!"TEAM".equals(space.spaceType()))return member(id,user);
        return new Context(space,mapper.role(id,user),true);
    }
    private Context member(String id,String user){var space=mapper.lock(id);var role=space==null?null:mapper.role(id,user);
        if(space==null||role==null||"PERSONAL".equals(space.spaceType())&&(!user.equals(space.personalUserId())||role!=OWNER))throw new SpaceFailure(403,"SPACE_FORBIDDEN");
        return new Context(space,role,false);}
    private Detail view(Context context){var s=context.space();var fixed=new FixedPermissionPolicy();
        var details=fixed.catalog().stream().sorted().map(action->{
            var reason=fixed.evaluate(context.role(),"ARCHIVED".equals(s.status()),"PERSONAL".equals(s.spaceType()),action);
            return new PermissionDetail(action,reason==FixedPermissionPolicy.Denial.NONE,reason.name());
        }).toList();
        return new Detail(s.id(),s.name(),s.spaceType(),s.status(),s.version(),context.role(),details,mapper.memberCount(s.id()),s.description(),s.avatarUrl(),mapper.ownerName(s.id()),context.platformAdmin()||context.role()==OWNER||context.role()==ADMIN);
    }
    public record Detail(String id,String name,String spaceType,String status,long version,SpaceRole role,List<PermissionDetail> permissionDetails,long memberCount,String description,String avatarUrl,String ownerName,boolean canInspectManagement) {}
    public record PermissionDetail(String action,boolean allowed,String reason) {}
    private InvitationView invitationView(SpaceMapper.Invitation value){String status="PENDING".equals(value.status())&&!mapper.now().isBefore(value.expiresAt())?"EXPIRED":value.status();
        return new InvitationView(value.id(),value.spaceId(),mapper.spaceName(value.spaceId()),value.invitedEmail(),value.inviterUserId(),mapper.userName(value.inviterUserId()),status,value.expiresAt());}
    private void recipient(SpaceMapper.Invitation value,String user){if(!user.equals(value.acceptedBy())&&!user.equals(value.recipientUserId()))throw new SpaceFailure(404,"NOT_FOUND");}
    private void requirePending(SpaceMapper.Invitation value,Caller caller,SessionService.UserPrincipal user){
        if(!"PENDING".equals(value.status()))throw new SpaceFailure(409,"INVITATION_NOT_PENDING");
        if(!mapper.now().isBefore(value.expiresAt())){mapper.invitationStatus(value.id(),"EXPIRED",null);audit(caller,user,"space.invitation.expire",value.spaceId(),null,value.id(),"expired");throw new SpaceFailure(409,"INVITATION_EXPIRED");}
    }
    private void rate(RedisRateLimiter.Bucket bucket,String subject){var value=limiter.getIfAvailable();if(value==null)throw new SpaceFailure(503,"AUTH_UNAVAILABLE");value.acquire(bucket,subject);}
    private static boolean personal(Context c){return "PERSONAL".equals(c.space().spaceType());}
    private static boolean archived(Context c){return "ARCHIVED".equals(c.space().status());}
    private static void require(boolean allowed){if(!allowed)throw new SpaceFailure(403,"SPACE_FORBIDDEN");}
    private static <T>T required(T value){if(value==null)throw new SpaceFailure(404,"NOT_FOUND");return value;}
    private static void match(long actual,long expected){if(actual!=expected)throw new SpaceFailure(409,"VERSION_CONFLICT");}
    private static void name(String value){if(value==null||value.isBlank()||!value.equals(value.strip())||value.length()>120||value.codePoints().anyMatch(Character::isISOControl))throw invalid();}
    private static void version(long value){if(value<0||value==Long.MAX_VALUE)throw invalid();}
    private static void uuid(String value){if(value==null||!value.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();}
    private static void pageArgs(String cursor,int limit){if(cursor!=null)uuid(cursor);if(limit<1||limit>200)throw invalid();}
    private static String cursor(String value){return value==null?"":value;}
    private static String id(){return UUID.randomUUID().toString();}
    private static SpaceFailure invalid(){return new SpaceFailure(400,"INVALID_REQUEST");}
    private static <T>Page<T> page(List<T> values,int limit,Function<T,String> id){var items=List.copyOf(values.subList(0,Math.min(limit,values.size())));return new Page<>(items,values.size()>limit?id.apply(items.getLast()):null);}
    public record Caller(String access,String origin,String requestId){@Override public String toString(){return "Caller[credential redacted]";}}
    private record Context(SpaceMapper.Space space,SpaceRole role,boolean platformAdmin){}
    private record Result(Object value,SpaceFailure failure){}
    public record Page<T>(List<T> items,String nextCursor){}
    public record InvitationView(String id,String spaceId,String spaceName,String invitedEmail,String inviterUserId,String inviterName,String status,Instant expiresAt){}
}
