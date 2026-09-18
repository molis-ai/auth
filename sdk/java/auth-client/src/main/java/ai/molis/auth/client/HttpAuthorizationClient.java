package ai.molis.auth.client;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.LongSupplier;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static ai.molis.auth.client.AuthFailure.Kind.*;

/** Only service tokens are cached. Every decision and scope page is a new dual-identity HTTP request. */
public final class HttpAuthorizationClient implements AuthorizationClient {
    private static final JsonMapper JSON=JsonMapper.builder(tools.jackson.core.json.JsonFactory.builder()
            .enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
            .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private static final Set<String> ROLES=Set.of("OWNER","ADMIN","MEMBER","VIEWER");
    private static final Set<String> DENIALS=Set.of("UNKNOWN_ACTION","APPLICATION_ACTION_FORBIDDEN","NO_MEMBERSHIP","ROLE_FORBIDDEN","PERSONAL_SPACE","ARCHIVED_SPACE");
    private final AuthOptions options;
    private final ServiceCredentials.Provider credentials;
    private final AuthTransport transport;
    private final LongSupplier nanoTime;
    private final Object lock=new Object();
    private ServiceToken cached;
    private CompletableFuture<ServiceToken> acquisition;
    public HttpAuthorizationClient(AuthOptions options,ServiceCredentials.Provider credentials,AuthTransport transport){this(options,credentials,transport,System::nanoTime);}
    HttpAuthorizationClient(AuthOptions options,ServiceCredentials.Provider credentials,AuthTransport transport,LongSupplier nanoTime){
        this.options=Objects.requireNonNull(options);this.credentials=Objects.requireNonNull(credentials);this.transport=Objects.requireNonNull(transport);this.nanoTime=Objects.requireNonNull(nanoTime);
    }
    @Override public Decision check(String user,String space,String action,Resource resource){
        user(user);uuidInput(space);actionInput(action);var body=new LinkedHashMap<String,Object>();body.put("spaceId",space);body.put("action",action);
        if(resource!=null){input(resource.type()!=null&&resource.type().matches("[a-z][a-z0-9_-]{0,31}")&&resource.id()!=null&&resource.id().matches("[A-Za-z0-9_.:-]{1,128}"));
            input(!resource.id().equals(user));body.put("resourceType",resource.type());body.put("resourceId",resource.id());}
        var result=query("check",user,body);var data=result.path("data");var flag=data.path("allowed");var reason=text(data,"reason");
        valid(flag.isBoolean()&&(flag.asBoolean()?reason.equals("NONE"):DENIALS.contains(reason)));
        return new Decision(flag.asBoolean(),reason,text(result,"requestId"),text(data,"decisionId"));
    }
    @Override public Actions allowedActions(String user,String space){
        user(user);uuidInput(space);var result=query("allowed-actions",user,Map.of("spaceId",space));var data=result.path("data");
        String role=text(data,"role");valid(ROLES.contains(role));var array=data.path("allowedActions");valid(array.isArray()&&array.size()<=200);
        var actions=new TreeSet<String>();for(var item:array){valid(item.isString()&&actionValid(item.asText())&&actions.add(item.asText()));}
        return new Actions(List.copyOf(actions),role,text(result,"requestId"),text(data,"decisionId"));
    }
    @Override public Activity recordUserActivity(String user){
        user(user);var result=query("activity",user,Map.of());var data=result.path("data");
        valid(data.path("recorded").isBoolean()&&data.path("recorded").asBoolean());
        return new Activity(text(result,"requestId"),text(data,"decisionId"));
    }
    @Override public SpacePage spaces(String user,String action,String cursor,int limit){
        user(user);actionInput(action);if(cursor!=null)uuidInput(cursor);input(limit>=1&&limit<=200);
        var body=new LinkedHashMap<String,Object>();body.put("action",action);body.put("limit",limit);if(cursor!=null)body.put("cursor",cursor);
        var result=query("spaces",user,body);var data=result.path("data");var array=data.path("spaces");valid(array.isArray()&&array.size()<=limit);
        var spaces=new ArrayList<Space>();String previous=cursor==null?"":cursor;
        for(var row:array){String id=text(row,"id"),name=text(row,"name"),type=text(row,"spaceType"),status=text(row,"status"),role=text(row,"role");
            valid(uuid(id)&&id.compareTo(previous)>0&&name.length()<=120&&Set.of("TEAM","PERSONAL").contains(type)&&Set.of("ACTIVE","ARCHIVED").contains(status)&&ROLES.contains(role));
            spaces.add(new Space(id,name,type,status,role));previous=id;}
        valid(data.has("nextCursor"));String next=data.path("nextCursor").isNull()?null:text(data,"nextCursor");
        valid(next==null||!spaces.isEmpty()&&next.equals(previous)&&spaces.size()==limit);
        return new SpacePage(spaces,next,text(result,"requestId"),text(data,"decisionId"));
    }
    @Override public List<String> authorizedSpaceIds(String user,String action,int maximum){
        input(maximum>=1&&maximum<=10000);var ids=new ArrayList<String>();String cursor=null;
        do{var page=spaces(user,action,cursor,Math.min(200,maximum-ids.size()+1));
            for(var space:page.spaces()){if(ids.size()==maximum)throw new AuthFailure(SCOPE_TOO_LARGE,page.requestId(),page.decisionId());ids.add(space.id());}
            cursor=page.nextCursor();
        }while(cursor!=null);
        return List.copyOf(ids);
    }
    private JsonNode query(String operation,String user,Map<String,Object> body){
        var token=serviceToken();var response=post("/api/v1/authorization/"+operation,Map.of("Authorization","Bearer "+token.value(),"X-User-Token",user,"Content-Type","application/json","Accept","application/json"),JSON.writeValueAsBytes(body));
        var result=parse(response);String request=optionalText(result,"requestId"),decision=optionalText(result,"decisionId");
        if(response.status()!=200){String code=optionalText(result.path("error"),"code");
            if(response.status()==401&&"SERVICE_UNAUTHENTICATED".equals(code)){synchronized(lock){if(cached==token)cached=null;}throw new AuthFailure(SERVICE_UNAUTHENTICATED,request,decision);}
            if(response.status()==401&&"USER_UNAUTHENTICATED".equals(code))throw new AuthFailure(USER_UNAUTHENTICATED,request,decision);
            if(response.status()==403)throw new AuthFailure(FORBIDDEN,request,decision);
            if(response.status()==429||response.status()>=500)throw new AuthFailure(UNAVAILABLE,request,decision);
            throw new AuthFailure(INVALID_RESPONSE,request,decision);
        }
        valid(uuid(request)&&result.path("data").isObject()&&uuid(optionalText(result.path("data"),"decisionId")));return result;
    }
    private ServiceToken serviceToken(){
        CompletableFuture<ServiceToken> future;boolean owner=false;
        synchronized(lock){if(cached!=null&&nanoTime.getAsLong()-cached.started()<cached.lifetimeNanos())return cached;
            if(acquisition==null){acquisition=new CompletableFuture<>();owner=true;}future=acquisition;}
        if(owner){try{var token=acquire();synchronized(lock){cached=token;}future.complete(token);}
            catch(RuntimeException failure){future.completeExceptionally(failure instanceof AuthFailure?failure:new AuthFailure(UNAVAILABLE));}
            finally{synchronized(lock){if(acquisition==future)acquisition=null;}}}
        try{return future.get();}catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw new AuthFailure(INTERRUPTED);}
        catch(ExecutionException failure){if(failure.getCause() instanceof AuthFailure safe)throw safe;throw new AuthFailure(UNAVAILABLE);}
    }
    private ServiceToken acquire(){
        long started=nanoTime.getAsLong();ServiceCredentials current=Objects.requireNonNull(credentials.current());
        String basic=Base64.getEncoder().encodeToString((form(current.clientId())+":"+form(current.secret())).getBytes(StandardCharsets.UTF_8));
        var response=post("/oauth2/token",Map.of("Authorization","Basic "+basic,"Content-Type","application/x-www-form-urlencoded","Accept","application/json"),"grant_type=client_credentials&scope=authorization".getBytes(StandardCharsets.UTF_8));
        var result=parse(response);
        if(response.status()!=200){if(response.status()==401)throw new AuthFailure(SERVICE_UNAUTHENTICATED);
            throw new AuthFailure(response.status()==429||response.status()>=500?UNAVAILABLE:INVALID_RESPONSE);}
        String token=text(result,"access_token");var lifetime=result.path("expires_in");
        valid(token.matches("[A-Za-z0-9_-]{43}")&&"Bearer".equals(text(result,"token_type"))&&"authorization".equals(text(result,"scope"))
                &&!result.has("refresh_token")&&lifetime.isIntegralNumber()&&lifetime.canConvertToInt()&&lifetime.asInt()>0&&lifetime.asInt()<=3600);
        long nanos=TimeUnit.SECONDS.toNanos(lifetime.asInt());nanos-=Math.min(TimeUnit.SECONDS.toNanos(5),nanos/10);
        valid(nanoTime.getAsLong()-started<nanos);return new ServiceToken(token,started,nanos);
    }
    private AuthTransport.Response post(String path,Map<String,String> headers,byte[] body){
        try{return transport.post(options.issuer().resolve(path),headers,body,options.requestTimeout());}
        catch(AuthFailure safe){throw safe;}catch(RuntimeException ignored){throw new AuthFailure(UNAVAILABLE);}
    }
    private static JsonNode parse(AuthTransport.Response response){
        if(response==null||response.body()==null||response.body().length>JdkAuthTransport.MAX_BYTES||response.contentType()==null
                ||!response.contentType().split(";",2)[0].strip().equalsIgnoreCase("application/json"))throw new AuthFailure(INVALID_RESPONSE);
        try{var result=JSON.readTree(response.body());valid(result!=null&&result.isObject());return result;}
        catch(AuthFailure safe){throw safe;}catch(RuntimeException ignored){throw new AuthFailure(INVALID_RESPONSE);}
    }
    private static String optionalText(JsonNode node,String key){return node.path(key).isString()?node.path(key).asText():null;}
    private static String text(JsonNode node,String key){String value=optionalText(node,key);valid(value!=null);return value;}
    private static String form(String value){return URLEncoder.encode(value,StandardCharsets.UTF_8);}
    private static boolean uuid(String value){return value!=null&&value.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}");}
    private static void uuidInput(String value){input(uuid(value));}
    private static void user(String value){input(value!=null&&value.matches("[A-Za-z0-9_-]{43}"));}
    private static boolean actionValid(String value){return value!=null&&value.matches("[a-z][a-z0-9_.]{0,99}");}
    private static void actionInput(String value){input(actionValid(value));}
    private static void input(boolean value){if(!value)throw new AuthFailure(INVALID_INPUT);}
    private static void valid(boolean value){if(!value)throw new AuthFailure(INVALID_RESPONSE);}
    private record ServiceToken(String value,long started,long lifetimeNanos){@Override public String toString(){return "ServiceToken[redacted]";}}
}
