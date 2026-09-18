package ai.molis.auth.authorization;

import ai.molis.auth.service.ServiceIdentityService;
import ai.molis.auth.session.SessionService;
import java.time.Clock;
import java.time.temporal.ChronoUnit;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Auth makes a space decision; the business backend owns resource-to-space resolution and enforcement. */
@Service
public final class AuthorizationService {
    private final SessionService sessions;
    private final ServiceIdentityService services;
    private final AuthorizationMapper mapper;
    private final Clock clock;
    private final ai.molis.auth.session.SessionMapper sessionRows;
    private final FixedPermissionPolicy policy=new FixedPermissionPolicy();
    private final TransactionTemplate transaction;
    public AuthorizationService(SessionService sessions,ServiceIdentityService services,AuthorizationMapper mapper,Clock clock,PlatformTransactionManager manager,ai.molis.auth.session.SessionMapper sessionRows) {
        this.sessionRows=sessionRows;
        this.sessions=sessions;this.services=services;this.mapper=mapper;this.clock=clock;
        transaction=new TransactionTemplate(manager);transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);transaction.setTimeout(10);
    }
    public Outcome execute(Credentials tokens,Query query,String requestId,String decisionId) {
        UUID.fromString(requestId);UUID.fromString(decisionId);
        return Objects.requireNonNull(transaction.execute(status->decide(tokens,query,requestId,decisionId)));
    }
    private Outcome decide(Credentials tokens,Query q,String request,String decision) {
        SessionService.UserPrincipal user=null;ServiceIdentityService.Principal service=null;
        try {
            // All mutations touching these identities must honor user -> login app/root/grant -> service -> space.
            user=sessions.requireActiveAccessLocked(tokens.userToken(),"account");
            service=services.requireActiveTokenLocked(tokens.serviceToken());
        } catch(SessionService.SessionRejectedException rejected) {
            return finish(q,request,decision,user,service,rejected.reason()==SessionService.Reason.INVALID_SCOPE?403:401,
                    rejected.reason()==SessionService.Reason.INVALID_SCOPE?"USER_SCOPE_REQUIRED":"USER_UNAUTHENTICATED",null);
        } catch(ServiceIdentityService.Rejected rejected) {
            return finish(q,request,decision,user,service,401,"SERVICE_UNAUTHENTICATED",null);
        }
        if(!user.applicationId().equals(service.applicationId()))return finish(q,request,decision,user,service,403,"APPLICATION_MISMATCH",null);
        if(q.operation()==Operation.ACTIVITY){
            var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
            sessionRows.touchAuthentication(user.authenticationId(),now);
            sessionRows.touchGrant(user.sessionId(),now);
            return finish(q,request,decision,user,service,200,null,new Activity(true,decision));
        }
        var overrides=mapper.rolePermissions(service.applicationId());
        var applicationActions=new HashSet<>(mapper.actions(service.applicationId()));
        if(q.operation()!=Operation.ACTIONS){
            String reason=!policy.catalog().contains(q.action())?"UNKNOWN_ACTION":!applicationActions.contains(q.action())?"APPLICATION_ACTION_FORBIDDEN":null;
            if(reason!=null)return finish(q,request,decision,user,service,q.operation()==Operation.CHECK?200:403,reason,
                    q.operation()==Operation.CHECK?new Decision(false,reason,decision):null);
        }
        if(q.operation()==Operation.SPACES){
            var rows=mapper.accessible(user.userId(),q.cursor()==null?"":q.cursor(),q.limit()+1,
                    roles(q.action(),false,overrides),roles(q.action(),true,overrides),evaluate(SpaceRole.OWNER,false,true,q.action(),overrides)==FixedPermissionPolicy.Denial.NONE);
            boolean more=rows.size()>q.limit();var page=List.copyOf(rows.subList(0,Math.min(rows.size(),q.limit())));
            return finish(q,request,decision,user,service,200,null,new Spaces(page,more?page.getLast().id():null,decision));
        }
        var space=mapper.lockSpace(q.spaceId());
        var role=space==null?null:mapper.membership(q.spaceId(),user.userId());
        if(space!=null&&"PERSONAL".equals(space.spaceType())&&!user.userId().equals(space.personalUserId()))role=null;
        if(q.operation()==Operation.ACTIONS){
            if(role==null)return finish(q,request,decision,user,service,403,"NO_MEMBERSHIP",null);
            var actions=new TreeSet<String>();
            for(String action:applicationActions)if(evaluate(role,"ARCHIVED".equals(space.status()),"PERSONAL".equals(space.spaceType()),action,overrides)==FixedPermissionPolicy.Denial.NONE)actions.add(action);
            actions.retainAll(applicationActions);
            return finish(q,request,decision,user,service,200,null,new Actions(List.copyOf(actions),role,decision));
        }
        var denied=evaluate(role,space!=null&&"ARCHIVED".equals(space.status()),space!=null&&"PERSONAL".equals(space.spaceType()),q.action(),overrides);
        String reason=denied==FixedPermissionPolicy.Denial.NONE?null:denied.name();
        return finish(q,request,decision,user,service,200,reason,new Decision(reason==null,reason==null?"NONE":reason,decision));
    }
    private FixedPermissionPolicy.Denial evaluate(SpaceRole role,boolean archived,boolean personal,String action,List<ApplicationRolePermission> overrides){
        Boolean granted=overrides.stream().filter(o->o.role()==role&&o.action().equals(action)).map(ApplicationRolePermission::allowed).findFirst().orElse(null);
        return policy.evaluate(role,archived,personal,action,granted);
    }
    private List<String> roles(String action,boolean archived,List<ApplicationRolePermission> overrides){
        var roles=Arrays.stream(SpaceRole.values()).filter(role->evaluate(role,archived,false,action,overrides)==FixedPermissionPolicy.Denial.NONE).map(Enum::name).toList();
        // Empty SQL IN lists are invalid. This fixed non-role value cannot match the constrained role column.
        return roles.isEmpty()?List.of("__NONE__"):roles;
    }
    private Outcome finish(Query q,String request,String decision,SessionService.UserPrincipal user,ServiceIdentityService.Principal service,int status,String reason,Object data){
        mapper.audit(new AuthorizationMapper.Audit(UUID.randomUUID().toString(),"authorization."+q.operation().name().toLowerCase(Locale.ROOT),
                reason==null?"SUCCESS":"DENIED",user==null?null:user.userId(),q.spaceId(),request,clock.instant().truncatedTo(ChronoUnit.MICROS),
                service==null?null:service.applicationId(),user==null?null:user.sessionId(),service==null?null:service.id(),decision,q.action(),reason,q.resourceType(),q.resourceId()));
        return new Outcome(status,status>=400?reason:null,data);
    }
    public enum Operation{CHECK,ACTIONS,SPACES,ACTIVITY}
    public record Activity(boolean recorded,String decisionId) {}
    public record Credentials(String serviceToken,String userToken){@Override public String toString(){return "Credentials[redacted]";}}
    public record Query(Operation operation,String spaceId,String action,String resourceType,String resourceId,String cursor,int limit) {}
    public record Outcome(int status,String error,Object data) {}
    public record Decision(boolean allowed,String reason,String decisionId) {}
    public record Actions(List<String> allowedActions,SpaceRole role,String decisionId) {}
    public record Spaces(List<AuthorizationMapper.SpaceItem> spaces,String nextCursor,String decisionId) {}
}
