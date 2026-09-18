package ai.molis.auth.platform;

import ai.molis.auth.authorization.FixedPermissionPolicy;
import ai.molis.auth.authorization.SpaceRole;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.service.ServiceIdentityService;
import ai.molis.auth.session.SessionMapper;
import ai.molis.auth.session.SessionService;
import java.net.URI;
import java.time.Clock;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.function.Function;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.*;
import org.springframework.transaction.support.TransactionTemplate;

/** Platform administration is deployment authority, never a space role or caller-supplied actor ID. */
@Service
@ConditionalOnProperty(name="auth.login.enabled",havingValue="true")
public final class PlatformService {
    private final PlatformMapper mapper;
    private final PlatformAdministrators administrators;
    private final SessionService sessions;
    private final SessionMapper sessionRows;
    private final ServiceIdentityService services;
    private final Clock clock;
    private final TransactionTemplate transaction;
    public PlatformService(PlatformMapper mapper,PlatformAdministrators administrators,SessionService sessions,
            SessionMapper sessionRows,ServiceIdentityService services,Clock clock,PlatformTransactionManager manager){
        this.mapper=mapper;this.administrators=administrators;this.sessions=sessions;this.sessionRows=sessionRows;
        this.services=services;this.clock=clock;transaction=new TransactionTemplate(manager);
        transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);transaction.setTimeout(10);
    }
    public Object me(Caller caller){return run(caller,null,user->Map.of("userId",user.userId(),"platformAdministrator",true));}
    public Object mail(Caller caller,String cursor,int limit){pageArgs(cursor,limit);return run(caller,null,
            user->page(mapper.mailPage(cursor(cursor),limit+1),limit,PlatformMapper.Mail::id));}
    public Object resendMail(Caller caller,String original){uuid(original);return run(caller,null,user->{
        var row=required(mapper.lockMail(original));
        if(!"FAILED".equals(row.status())||row.resendOf()!=null
                ||!Set.of("ACCOUNT_REGISTERED","PASSWORD_CHANGED","SPACE_INVITED").contains(row.templateKey()))
            throw new PlatformFailure(409,"MAIL_NOT_RETRYABLE");
        String existing=mapper.mailRetry(original);
        if(existing!=null)return Map.of("id",existing,"alreadyQueued",true);
        String retry=id();
        if(mapper.retryMail(original,retry)!=1)throw new PlatformFailure(409,"MAIL_NOT_RETRYABLE");
        audit(caller,user,"platform.mail.resend",null,null,null,"original="+original+"; retry="+retry);
        return Map.of("id",retry,"alreadyQueued",false);
    });}
    public Object catalog(Caller caller){return run(caller,null,user->new FixedPermissionPolicy().catalog().stream().sorted().toList());}
    public Object applications(Caller caller,String cursor,int limit){pageArgs(cursor,limit);return run(caller,null,user->page(mapper.applications(cursor(cursor),limit+1),limit,PlatformMapper.Application::id));}
    public Object permissionMatrix(Caller caller,String app){
        uuid(app);return run(caller,null,user->{
            var application=applicationView(required(mapper.lockApplication(app)));
            if(mapper.isConsoleApplication(app)>0)return consoleMatrix(application);
            var policy=new FixedPermissionPolicy();
            var overrides=mapper.rolePermissions(app);
            var roles=Arrays.stream(new SpaceRole[]{SpaceRole.OWNER,SpaceRole.ADMIN,SpaceRole.MEMBER,SpaceRole.VIEWER})
                .map(role->new RolePermissionView(role.name(),application.actions().stream()
                    .filter(action->"ACTIVE".equals(application.status()) && policy.evaluate(role,false,false,action,overrides.stream().filter(o->o.role()==role && o.action().equals(action)).map(ai.molis.auth.authorization.ApplicationRolePermission::allowed).findFirst().orElse(null))==FixedPermissionPolicy.Denial.NONE).toList())).toList();
            return new PermissionMatrixView(application,roles,false);
        });
    }
    public Object savePermissionMatrix(Caller caller,String app,Set<String> grants,long version){
        uuid(app);version(version);if(grants==null||grants.size()>400)throw invalid();
        return run(caller,null,user->{
            var current=required(mapper.lockApplication(app));
            if(mapper.isConsoleApplication(app)>0)throw new PlatformFailure(403,"BUILTIN_PERMISSIONS_READ_ONLY");
            active(current.status());match(current.version(),version);
            var actions=mapper.actions(app);var valid=new HashSet<String>();
            for(var role:SpaceRole.values())for(var action:actions)valid.add(role.name()+":"+action);
            if(!valid.containsAll(grants))throw invalid();
            var before=mapper.rolePermissions(app);var fixed=new FixedPermissionPolicy();var changes=new ArrayList<String>();
            mapper.clearRolePermissions(app);
            for(var role:SpaceRole.values())for(var action:actions){
                boolean allowed=grants.contains(role.name()+":"+action);
                boolean old=fixed.evaluate(role,false,false,action,before.stream().filter(o->o.role()==role&&o.action().equals(action)).map(ai.molis.auth.authorization.ApplicationRolePermission::allowed).findFirst().orElse(null))==FixedPermissionPolicy.Denial.NONE;
                if(old!=allowed)changes.add(role.name()+":"+action+"="+allowed);
                mapper.addRolePermission(app,role.name(),action,allowed);
            }
            mapper.bumpPermissionVersion(app);
            audit(caller,user,"platform.permissions.update",null,app,null,"version="+(version+1)+"; "+String.join(",",changes));
            return Map.of("saved",true,"version",version+1);
        });
    }
    public record RolePermissionView(String role,List<String> actions){}
    public record PermissionMatrixView(ApplicationView application,List<RolePermissionView> roles,boolean console){}
    private PermissionMatrixView consoleMatrix(ApplicationView application){
        var membership=new ai.molis.auth.authorization.MembershipPolicy();
        var capabilities=List.of("team.read","team.update","members.read","members.invite","members.role","members.remove","invitations.read","invitations.revoke","audit.read","team.archive","team.leave");
        var roles=Arrays.stream(SpaceRole.values()).map(role->{
            var allowed=new ArrayList<String>();
            if("ACTIVE".equals(application.status())){
                allowed.addAll(List.of("team.read","members.read"));
                if(role==SpaceRole.OWNER||role==SpaceRole.ADMIN)allowed.addAll(List.of("team.update","invitations.read","invitations.revoke","audit.read"));
                if(membership.canInvite(role,false,false))allowed.add("members.invite");
                if(Arrays.stream(SpaceRole.values()).anyMatch(target->Arrays.stream(SpaceRole.values()).anyMatch(replacement->membership.canChangeRole(role,target,replacement,false,false))))allowed.add("members.role");
                if(Arrays.stream(SpaceRole.values()).anyMatch(target->membership.canRemove(role,target,false)))allowed.add("members.remove");
                if(role==SpaceRole.OWNER)allowed.add("team.archive");
                if(membership.canLeave(role,false))allowed.add("team.leave");
            }
            return new RolePermissionView(role.name(),allowed);
        }).toList();
        return new PermissionMatrixView(new ApplicationView(application.id(),application.name(),application.status(),application.version(),capabilities),roles,true);
    }
    public Object application(Caller caller,String app){uuid(app);return run(caller,null,user->applicationView(required(mapper.lockApplication(app))));}
    public Object createApplication(Caller caller,String name,Set<String> actions){
        name(name,120);actions(actions);
        return run(caller,null,user->{String id=id();mapper.createApplication(id,name);replaceActions(id,actions);
            audit(caller,user,"platform.application.create",null,id,null,"created; permissions="+actions.size());return applicationView(mapper.application(id));});
    }
    public Object updateApplication(Caller caller,String app,String name,String status,Set<String> actions,long version){
        uuid(app);name(name,120);status(status);actions(actions);version(version);
        return run(caller,null,user->{var current=required(mapper.lockApplication(app));match(current.version(),version);
            mapper.updateApplication(app,name,status);replaceActions(app,actions);
            if("DISABLED".equals(status)){
                var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
                mapper.revokeApplicationGrants(app,now);mapper.revokeApplicationServiceCredentials(app,now);
            }
            audit(caller,user,"platform.application.update",null,app,null,current.status()+"->"+status+"; version="+(version+1)+"; permissions="+actions.size());
            return applicationView(mapper.application(app));});
    }
    public Object clients(Caller caller,String app,String cursor,int limit){uuid(app);pageArgs(cursor,limit);return run(caller,null,user->{
        required(mapper.application(app));return page(mapper.clients(app,cursor(cursor),limit+1),limit,PlatformMapper.Client::id);});}
    public Object client(Caller caller,String client){clientId(client);return run(caller,null,user->{
        var candidate=required(mapper.client(client));required(mapper.lockApplication(candidate.applicationId()));
        return clientView(required(mapper.lockClient(client)));});}
    public Object createClient(Caller caller,String app,String client,String type,Set<String> scopes,Set<String> redirects){
        uuid(app);clientId(client);if(client.startsWith("svc_"))throw invalid();clientConfig(type,scopes,redirects);
        return run(caller,null,user->{active(required(mapper.lockApplication(app)).status());String id=id();
            mapper.createClient(id,client,app,type,scopeString(scopes));for(String uri:redirects)mapper.addRedirect(id,uri);
            audit(caller,user,"platform.client.create",null,app,id,"type="+type+"; redirects="+redirects.size());return clientView(mapper.client(client));});
    }
    public Object updateClient(Caller caller,String client,String status,Set<String> scopes,Set<String> redirects,long version){
        clientId(client);status(status);version(version);
        return run(caller,null,user->{var candidate=required(mapper.client(client));required(mapper.lockApplication(candidate.applicationId()));
            var current=required(mapper.lockClient(client));match(current.version(),version);clientConfig(current.clientType(),scopes,redirects);
            mapper.updateClient(current.id(),status,scopeString(scopes));mapper.clearRedirects(current.id());
            for(String uri:redirects)mapper.addRedirect(current.id(),uri);
            mapper.revokeClientGrants(current.id(),clock.instant().truncatedTo(ChronoUnit.MICROS));
            audit(caller,user,"platform.client.update",null,current.applicationId(),current.id(),current.status()+"->"+status+"; version="+(version+1)+"; redirects="+redirects.size());
            return clientView(mapper.client(client));});
    }
    public Object serviceClients(Caller caller,String app,String cursor,int limit){uuid(app);pageArgs(cursor,limit);return run(caller,null,user->{
        required(mapper.application(app));return page(mapper.services(app,cursor(cursor),limit+1),limit,PlatformMapper.ServiceClient::id);});}
    public Object createService(Caller caller,String app,String name){uuid(app);name(name,200);return run(caller,null,user->services.createLocked(app,name,user.userId(),caller.requestId()));}
    public Object rotateService(Caller caller,String client){clientId(client);return run(caller,null,user->services.rotateLocked(client,user.userId(),caller.requestId()));}
    public Object disableService(Caller caller,String client){clientId(client);return run(caller,null,user->{services.disableLocked(client,user.userId(),caller.requestId());return Map.of("disabled",true);});}
    public Object users(Caller caller,String cursor,int limit){pageArgs(cursor,limit);return run(caller,null,user->page(mapper.users(cursor(cursor),limit+1),limit,PlatformMapper.User::id));}
    public Object user(Caller caller,String target){uuid(target);return run(caller,null,user->userView(required(mapper.user(target))));}
    public Object userStatus(Caller caller,String target,String status){uuid(target);status(status);return run(caller,target,user->{
        var current=required(mapper.user(target));var now=clock.instant().truncatedTo(ChronoUnit.MICROS);
        mapper.userStatus(target,status,now);
        if("DISABLED".equals(status)){sessionRows.revokeUserAuthentications(target,now);sessionRows.revokeUserGrants(target,now);}
        audit(caller,user,"platform.user.status",target,null,null,current.status()+"->"+status);return userView(mapper.user(target));});}
    public Object auditEvents(Caller caller,String cursor,int limit){pageArgs(cursor,limit);return run(caller,null,user->{
        var time=cursor==null?null:mapper.auditTime(cursor);if(cursor!=null&&time==null)throw invalid();
        return page(mapper.auditPage(time,cursor,limit+1),limit,PlatformMapper.AuditView::id);});}

    private Object run(Caller caller,String target,Function<SessionService.UserPrincipal,Object> work){
        uuid(caller.requestId());
        var result=Objects.requireNonNull(transaction.execute(tx->{
            SessionService.UserPrincipal user;
            try{
                // Lock both users in deterministic order before revalidating the administrator's session.
                // This also prevents a concurrent disable from racing any authorized management mutation.
                if(target!=null&&caller.access()!=null&&caller.access().matches("[A-Za-z0-9_-]{43}")){
                    var candidate=sessionRows.findAccess(TokenSecrets.digest(caller.access()));
                    if(candidate!=null)for(String id:new TreeSet<>(List.of(candidate.userId(),target)))sessionRows.lockUser(id);
                }
                user=sessions.requireActiveAccessLocked(caller.access(),"account");
            }catch(SessionService.SessionRejectedException failure){
                int status=failure.reason()==SessionService.Reason.INVALID_SCOPE?403:401;
                String code=status==403?"ACCOUNT_SCOPE_REQUIRED":"UNAUTHENTICATED";
                denied(caller,null,code);return new Result(null,new PlatformFailure(status,code));
            }
            if(!administrators.contains(user.userId())){
                denied(caller,user.userId(),"PLATFORM_ADMIN_REQUIRED");return new Result(null,new PlatformFailure(403,"PLATFORM_ADMIN_REQUIRED"));
            }
            return new Result(work.apply(user),null);
        }));
        // Throw only after committing denial audit; operational/audit failures still roll back atomically.
        if(result.failure()!=null)throw result.failure();return result.value();
    }
    private void denied(Caller caller,String actor,String code){mapper.audit(new PlatformMapper.Audit(id(),"platform.access","DENIED",actor,null,caller.requestId(),clock.instant().truncatedTo(ChronoUnit.MICROS),null,null,code));}
    private void audit(Caller caller,SessionService.UserPrincipal actor,String action,String user,String app,String client,String summary){
        mapper.audit(new PlatformMapper.Audit(id(),action,"SUCCESS",actor.userId(),user,caller.requestId(),clock.instant().truncatedTo(ChronoUnit.MICROS),app,client,summary));
    }
    private ApplicationView applicationView(PlatformMapper.Application app){return new ApplicationView(app.id(),app.name(),app.status(),app.version(),mapper.actions(app.id()));}
    private ClientView clientView(PlatformMapper.Client client){return new ClientView(client.id(),client.clientId(),client.applicationId(),client.clientType(),client.status(),client.version(),List.of(client.allowedScopes().split(" ")),mapper.redirects(client.id()));}
    private UserView userView(PlatformMapper.User user){return new UserView(user.id(),user.displayName(),user.status(),mapper.emails(user.id()));}
    private void replaceActions(String app,Set<String> actions){mapper.clearActions(app);for(String action:new TreeSet<>(actions))mapper.addAction(app,action);mapper.cleanRolePermissions(app);}
    private static void actions(Set<String> actions){if(actions==null||!new FixedPermissionPolicy().catalog().containsAll(actions))throw invalid();}
    private static void clientConfig(String type,Set<String> scopes,Set<String> redirects){
        if(type==null||!Set.of("WEB","MACOS","CLI").contains(type)||scopes==null||scopes.isEmpty()||!Set.of("account","profile").containsAll(scopes)
                ||redirects==null||redirects.isEmpty()||redirects.size()>20)throw invalid();
        for(String redirect:redirects){
            if(redirect==null||redirect.length()>1024||!redirect.matches("[\\x21-\\x7E]+")||redirect.contains("*"))throw invalid();
            URI uri=URI.create(redirect);String scheme=uri.getScheme();
            if(!uri.isAbsolute()||uri.isOpaque()||uri.getFragment()!=null||uri.getUserInfo()!=null||uri.getHost()==null)throw invalid();
            boolean web="http".equals(scheme)||"https".equals(scheme);
            if("WEB".equals(type)&&!web||"http".equals(scheme)&&!ai.molis.auth.login.LoginClientPolicy.loopback(uri.getHost()))throw invalid();
            // Native custom schemes must be reverse-domain names; disallow file/data/javascript and other generic schemes.
            if(!web&&!scheme.matches("[a-z][a-z0-9-]*(\\.[a-z0-9-]+)+"))throw invalid();
            if(uri.getRawQuery()!=null)for(String part:uri.getRawQuery().split("&")){
                String key=java.net.URLDecoder.decode(part.split("=",2)[0],java.nio.charset.StandardCharsets.UTF_8);
                if(Set.of("code","state","error").contains(key))throw invalid();
            }
        }
    }
    private static void clientId(String value){if(value==null||!value.matches("[A-Za-z0-9][A-Za-z0-9_.-]{0,99}"))throw invalid();}
    private static String scopeString(Set<String> scopes){return String.join(" ",new TreeSet<>(scopes));}
    private static void name(String value,int max){if(value==null||value.isBlank()||!value.equals(value.strip())||value.length()>max||value.codePoints().anyMatch(Character::isISOControl))throw invalid();}
    private static void status(String value){if(value==null||!Set.of("ACTIVE","DISABLED").contains(value))throw invalid();}
    private static void version(long value){if(value<0||value==Long.MAX_VALUE)throw invalid();}
    private static void match(long actual,long expected){if(actual!=expected)throw new PlatformFailure(409,"VERSION_CONFLICT");}
    private static void active(String value){if(!"ACTIVE".equals(value))throw new PlatformFailure(409,"APPLICATION_DISABLED");}
    private static void uuid(String value){if(value==null||!value.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();}
    private static void pageArgs(String cursor,int limit){if(cursor!=null)uuid(cursor);if(limit<1||limit>200)throw invalid();}
    private static String cursor(String value){return value==null?"":value;}
    private static String id(){return UUID.randomUUID().toString();}
    private static <T>T required(T value){if(value==null)throw new PlatformFailure(404,"NOT_FOUND");return value;}
    private static PlatformFailure invalid(){return new PlatformFailure(400,"INVALID_REQUEST");}
    private static <T>Page<T> page(List<T> rows,int limit,Function<T,String> key){var values=List.copyOf(rows.subList(0,Math.min(limit,rows.size())));return new Page<>(values,rows.size()>limit?key.apply(values.getLast()):null);}
    public record Caller(String access,String requestId){@Override public String toString(){return "Caller[credential redacted]";}}
    private record Result(Object value,PlatformFailure failure){}
    public record Page<T>(List<T> items,String nextCursor){}
    public record ApplicationView(String id,String name,String status,long version,List<String> actions){}
    public record ClientView(String id,String clientId,String applicationId,String clientType,String status,long version,List<String> scopes,List<String> redirects){}
    public record UserView(String id,String displayName,String status,List<String> emails){}
}
