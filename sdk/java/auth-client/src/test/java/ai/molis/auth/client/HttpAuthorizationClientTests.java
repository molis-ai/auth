package ai.molis.auth.client;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static ai.molis.auth.client.AuthFailure.Kind.*;

class HttpAuthorizationClientTests {
    static final String USER="u".repeat(43),TOKEN="t".repeat(43),SECRET="s".repeat(43),SPACE="00000000-0000-0000-0000-000000000001";
    static final String ID="00000000-0000-0000-0000-000000000099",CLIENT="svc_"+ID;
    static final AuthOptions OPTIONS=AuthOptions.production(URI.create("https://auth.example.test"));
    static final ServiceCredentials CREDS=new ServiceCredentials(CLIENT,SECRET);
    static String envelope(String data){return "{\"data\":"+data+",\"requestId\":\""+ID+"\"}";}
    static String decision(boolean allowed){return envelope("{\"allowed\":"+allowed+",\"reason\":\""+(allowed?"NONE":"ROLE_FORBIDDEN")+"\",\"decisionId\":\""+ID+"\"}");}
    static AuthTransport.Response json(int status,String body){return new AuthTransport.Response(status,"application/json; charset=UTF-8",body.getBytes(StandardCharsets.UTF_8));}
    static AuthTransport.Response token(){return json(200,"{\"access_token\":\""+TOKEN+"\",\"token_type\":\"Bearer\",\"expires_in\":300,\"scope\":\"authorization\"}");}
    static String failure(String code){return "{\"error\":{\"code\":\""+code+"\"},\"requestId\":\""+ID+"\",\"decisionId\":\""+ID+"\"}";}
    record Call(URI uri,Map<String,String> headers,String body){}
    static class Wire implements AuthTransport {
        final List<Call> calls=new CopyOnWriteArrayList<>();
        Function<Call,Response> handler=c->c.uri().getPath().equals("/oauth2/token")?token():json(200,decision(true));
        public Response post(URI uri,Map<String,String> headers,byte[] body,Duration timeout){var call=new Call(uri,headers,new String(body,StandardCharsets.UTF_8));calls.add(call);return handler.apply(call);}
        long tokens(){return calls.stream().filter(c->c.uri().getPath().equals("/oauth2/token")).count();}
    }
    static HttpAuthorizationClient client(Wire wire){return new HttpAuthorizationClient(OPTIONS,()->CREDS,wire);}
    @Test void activityIsExplicitDualIdentityAndNeverAutomaticallyRetried(){
        var wire=new Wire();var client=client(wire);
        wire.handler=c->c.uri().getPath().equals("/oauth2/token")?token():json(200,envelope("{\"recorded\":true,\"decisionId\":\""+ID+"\"}"));
        assertEquals(ID,client.recordUserActivity(USER).decisionId());
        var call=wire.calls.getLast();assertEquals("/api/v1/authorization/activity",call.uri().getPath());
        assertEquals("{}",call.body());assertEquals(USER,call.headers().get("X-User-Token"));
        wire.handler=c->json(503,failure("AUTH_UNAVAILABLE"));
        int before=wire.calls.size();fails(UNAVAILABLE,()->client.recordUserActivity(USER));assertEquals(before+1,wire.calls.size());
    }
    static AuthFailure fails(AuthFailure.Kind kind,Runnable action){var failure=assertThrows(AuthFailure.class,action::run);assertEquals(kind,failure.kind());return failure;}
    @Test void sendsDistinctIdentitiesAndNeverCachesDecisions(){
        var wire=new Wire();var client=client(wire);
        assertTrue(client.check(USER,SPACE,"feed.read",new AuthorizationClient.Resource("feed","feed_1")).allowed());
        wire.handler=c->json(200,decision(false));
        assertFalse(client.check(USER,SPACE,"feed.read",null).allowed());assertEquals(3,wire.calls.size());assertEquals(1,wire.tokens());
        var token=wire.calls.getFirst();assertEquals("grant_type=client_credentials&scope=authorization",token.body());
        assertEquals("Basic "+Base64.getEncoder().encodeToString((CLIENT+":"+SECRET).getBytes(StandardCharsets.UTF_8)),token.headers().get("Authorization"));
        var call=wire.calls.get(1);assertEquals("Bearer "+TOKEN,call.headers().get("Authorization"));assertEquals(USER,call.headers().get("X-User-Token"));
        assertFalse(call.headers().containsKey("Cookie"));assertFalse(call.headers().containsKey("Origin"));assertFalse(call.body().contains(USER));assertTrue(call.body().contains("feed_1"));
    }
    @Test void coalescesConcurrentServiceAcquisition()throws Exception{
        var wire=new Wire();var client=client(wire);var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(20)){var futures=new ArrayList<Future<Boolean>>();
            for(int i=0;i<20;i++)futures.add(pool.submit(()->{start.await();return client.check(USER,SPACE,"feed.read",null).allowed();}));
            start.countDown();for(var future:futures)assertTrue(future.get(5,TimeUnit.SECONDS));}
        assertEquals(1,wire.tokens());assertEquals(21,wire.calls.size());
    }
    @Test void expiresEarlyUsingMonotonicTimeAndRequestStart(){
        var wire=new Wire();var clock=new AtomicLong();var client=new HttpAuthorizationClient(OPTIONS,()->CREDS,wire,clock::get);
        client.check(USER,SPACE,"feed.read",null);clock.set(TimeUnit.SECONDS.toNanos(294));client.check(USER,SPACE,"feed.read",null);assertEquals(1,wire.tokens());
        clock.set(TimeUnit.SECONDS.toNanos(295));client.check(USER,SPACE,"feed.read",null);assertEquals(2,wire.tokens());
        var slow=new Wire();slow.handler=c->{clock.addAndGet(TimeUnit.SECONDS.toNanos(301));return token();};
        fails(INVALID_RESPONSE,()->new HttpAuthorizationClient(OPTIONS,()->CREDS,slow,clock::get).check(USER,SPACE,"feed.read",null));
    }
    @Test void service401InvalidatesOnlyForNextCallWithoutRetryAndReadsRotatedProvider(){
        var wire=new Wire();var count=new AtomicInteger();wire.handler=c->c.uri().getPath().equals("/oauth2/token")?token():json(401,failure("SERVICE_UNAUTHENTICATED"));
        var client=new HttpAuthorizationClient(OPTIONS,()->{count.incrementAndGet();return CREDS;},wire);
        fails(SERVICE_UNAUTHENTICATED,()->client.check(USER,SPACE,"feed.read",null));assertEquals(2,wire.calls.size());
        wire.handler=c->c.uri().getPath().equals("/oauth2/token")?token():json(200,decision(true));
        assertTrue(client.check(USER,SPACE,"feed.read",null).allowed());assertEquals(2,count.get());assertEquals(4,wire.calls.size());
    }
    @Test void user401DoesNotEvictServiceTokenAndDenyIsNotAnOutage(){
        var wire=new Wire();wire.handler=c->c.uri().getPath().equals("/oauth2/token")?token():json(401,failure("USER_UNAUTHENTICATED"));var client=client(wire);
        fails(USER_UNAUTHENTICATED,()->client.check(USER,SPACE,"feed.read",null));
        wire.handler=c->json(200,decision(false));var error=fails(DENIED,()->client.requireAllowed(USER,SPACE,"feed.read",null));assertEquals(ID,error.decisionId());assertEquals(1,wire.tokens());
        wire.handler=c->json(503,failure("AUTH_UNAVAILABLE"));fails(UNAVAILABLE,()->client.check(USER,SPACE,"feed.read",null));
        wire.handler=c->json(403,failure("APPLICATION_MISMATCH"));fails(FORBIDDEN,()->client.check(USER,SPACE,"feed.read",null));
    }
    @Test void malformedOrCoercedDecisionsNeverAllow(){
        for(String data:List.of(decision(true).replace("true","\"true\""),decision(true).replace("NONE","NEW_REASON"),
                decision(true)+" {}",decision(true).replace("\"allowed\":true","\"allowed\":false,\"allowed\":true"),"{}",decision(true).replace(ID,"not-an-id"))){
            var wire=new Wire();wire.handler=c->c.uri().getPath().equals("/oauth2/token")?token():json(200,data);
            fails(INVALID_RESPONSE,()->client(wire).check(USER,SPACE,"feed.read",null));
        }
    }
    @Test void invalidTokenResponsesAndTransportSecretsAreNotExposed(){
        for(String response:List.of(new String(token().body(),StandardCharsets.UTF_8).replace("300","\"300\""),
                new String(token().body(),StandardCharsets.UTF_8).replace("authorization","account"),
                new String(token().body(),StandardCharsets.UTF_8).replace("\"scope\"","\"refresh_token\":\"private\",\"scope\""))){
            var wire=new Wire();wire.handler=c->json(200,response);fails(INVALID_RESPONSE,()->client(wire).check(USER,SPACE,"feed.read",null));}
        var wire=new Wire();wire.handler=c->{throw new IllegalStateException(SECRET);};var error=fails(UNAVAILABLE,()->client(wire).check(USER,SPACE,"feed.read",null));
        assertNull(error.getCause());assertFalse(error.toString().contains(SECRET));assertFalse(CREDS.toString().contains(SECRET));assertFalse(token().toString().contains(TOKEN));
    }
    static String space(String id){return "{\"id\":\""+id+"\",\"name\":\"Team\",\"spaceType\":\"TEAM\",\"status\":\"ACTIVE\",\"role\":\"MEMBER\"}";}
    static String page(String rows,String cursor){return envelope("{\"spaces\":["+rows+"],\"nextCursor\":"+(cursor==null?"null":"\""+cursor+"\"")+",\"decisionId\":\""+ID+"\"}");}
    @Test void readsAllScopePagesBeforeReturningAndRefusesTruncation(){
        String second="00000000-0000-0000-0000-000000000002";var wire=new Wire();
        wire.handler=c->c.uri().getPath().equals("/oauth2/token")?token():json(200,page(space(SPACE)+","+space(second),null));
        assertEquals(List.of(SPACE,second),client(wire).authorizedSpaceIds(USER,"project.read",2));
        fails(SCOPE_TOO_LARGE,()->client(wire).authorizedSpaceIds(USER,"project.read",1));
        // Explicit page API also rejects non-advancing, duplicate or out-of-order scope IDs.
        for(String bad:List.of(page(space(SPACE)+","+space(SPACE),null),page(space(second)+","+space(SPACE),null),page("",SPACE),page(space(SPACE),second))){
            wire.handler=c->c.uri().getPath().equals("/oauth2/token")?token():json(200,bad);
            fails(INVALID_RESPONSE,()->client(wire).spaces(USER,"project.read",null,2));}
    }
    @Test void scopeCollectionDoesNotSilentlyStopAtFirstTwoHundred(){
        var wire=new Wire();String rows=java.util.stream.IntStream.rangeClosed(1,200).mapToObj(i->space(String.format("00000000-0000-0000-0000-%012d",i))).collect(java.util.stream.Collectors.joining(","));
        String last="00000000-0000-0000-0000-000000000200",next="00000000-0000-0000-0000-000000000201";
        wire.handler=c->c.uri().getPath().equals("/oauth2/token")?token():json(200,c.body().contains("cursor")?page(space(next),null):page(rows,last));
        var all=client(wire).authorizedSpaceIds(USER,"project.read",300);assertEquals(201,all.size());assertEquals(next,all.getLast());assertEquals(3,wire.calls.size());
    }
    @Test void actionsAreImmutableAndNeverConstituteAnExecutionDecision(){
        var wire=new Wire();wire.handler=c->c.uri().getPath().equals("/oauth2/token")?token():json(200,envelope("{\"allowedActions\":[\"project.read\"],\"role\":\"MEMBER\",\"decisionId\":\""+ID+"\"}"));
        var client=client(wire);var actions=client.allowedActions(USER,SPACE);assertEquals(List.of("project.read"),actions.allowedActions());
        assertThrows(UnsupportedOperationException.class,()->actions.allowedActions().add("project.delete"));
        wire.handler=c->json(200,decision(false));fails(DENIED,()->client.requireAllowed(USER,SPACE,"project.read",null));assertEquals(3,wire.calls.size());
    }
    @Test void invalidInputsFailBeforeAnyServiceCredentialRequest(){
        var wire=new Wire();var client=client(wire);
        fails(INVALID_INPUT,()->client.check("bad",SPACE,"feed.read",null));fails(INVALID_INPUT,()->client.check(USER,"bad","feed.read",null));
        fails(INVALID_INPUT,()->client.check(USER,SPACE,"feed:read",null));fails(INVALID_INPUT,()->client.check(USER,SPACE,"feed.read",new AuthorizationClient.Resource("feed",USER)));
        fails(INVALID_INPUT,()->client.spaces(USER,"feed.read",null,201));assertTrue(wire.calls.isEmpty());
        for(String uri:List.of("http://auth.example.test","https://user:password@auth.example.test","https://auth.example.test/base","https://auth.example.test?token=secret","https://auth.example.test#fragment","file:///tmp/auth"))
            fails(INVALID_INPUT,()->AuthOptions.production(URI.create(uri)));
        fails(INVALID_INPUT,()->new AuthOptions(URI.create("http://localhost.evil.test"),true,Duration.ofSeconds(1),Duration.ofSeconds(1)));
    }
}
