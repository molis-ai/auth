package ai.molis.auth.client;

import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
import static ai.molis.auth.client.AuthFailure.Kind.*;

class JdkAuthTransportTests {
    HttpServer server;ExecutorService executor;JdkAuthTransport transport;URI origin;
    @BeforeEach void start()throws Exception{server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);executor=Executors.newVirtualThreadPerTaskExecutor();server.setExecutor(executor);server.start();
        origin=URI.create("http://127.0.0.1:"+server.getAddress().getPort());transport=new JdkAuthTransport(new AuthOptions(origin,true,Duration.ofSeconds(1),Duration.ofSeconds(1)));}
    @AfterEach void stop(){transport.close();server.stop(0);executor.shutdownNow();}
    AuthTransport.Response post(String path){return transport.post(origin.resolve(path),Map.of("Content-Type","application/json"),"{}".getBytes(StandardCharsets.UTF_8),Duration.ofMillis(250));}
    @Test void neverFollowsRedirectsOrCarriesAmbientCookies(){var redirects=new AtomicInteger();server.createContext("/target",exchange->{redirects.incrementAndGet();exchange.sendResponseHeaders(204,-1);exchange.close();});
        server.createContext("/redirect",exchange->{assertNull(exchange.getRequestHeaders().getFirst("Cookie"));assertNull(exchange.getRequestHeaders().getFirst("Origin"));exchange.getResponseHeaders().set("Location",origin+"/target");exchange.sendResponseHeaders(307,-1);exchange.close();});
        assertEquals(307,post("/redirect").status());assertEquals(0,redirects.get());}
    @Test void totalDeadlineIncludesSlowResponseBody(){server.createContext("/slow",exchange->{exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(200,100);exchange.getResponseBody().write('{');exchange.getResponseBody().flush();
        try{new CountDownLatch(1).await(2,TimeUnit.SECONDS);}catch(InterruptedException ignored){Thread.currentThread().interrupt();}finally{exchange.close();}});
        long start=System.nanoTime();assertEquals(UNAVAILABLE,assertThrows(AuthFailure.class,()->post("/slow")).kind());assertTrue(System.nanoTime()-start<TimeUnit.SECONDS.toNanos(2));}
    @Test void limitsActualStreamSizeWithoutTrustingContentLength(){server.createContext("/large",exchange->{exchange.sendResponseHeaders(200,0);try{exchange.getResponseBody().write(new byte[JdkAuthTransport.MAX_BYTES+1]);}finally{exchange.close();}});
        assertEquals(UNAVAILABLE,assertThrows(AuthFailure.class,()->post("/large")).kind());}
    @Test void rejectsCustomClientWithCredentialLeakingPolicies(){
        try(var client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.ALWAYS).build()){assertThrows(AuthFailure.class,()->new JdkAuthTransport(client));}
        try(var client=HttpClient.newBuilder().cookieHandler(new CookieManager()).build()){assertThrows(AuthFailure.class,()->new JdkAuthTransport(client));}
    }
    @Test void interruptionRemainsSetAndDoesNotLeakTransportDetails(){server.createContext("/ok",exchange->{exchange.sendResponseHeaders(204,-1);exchange.close();});Thread.currentThread().interrupt();
        try{assertEquals(INTERRUPTED,assertThrows(AuthFailure.class,()->post("/ok")).kind());assertTrue(Thread.currentThread().isInterrupted());}finally{Thread.interrupted();}}
}
