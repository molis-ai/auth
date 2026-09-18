package ai.molis.auth.federation;

import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import static org.assertj.core.api.Assertions.*;

class ProviderHttpTests {
    HttpServer server;ExecutorService executor;ProviderHttp http;
    @BeforeEach void start()throws Exception {server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);executor=Executors.newVirtualThreadPerTaskExecutor();server.setExecutor(executor);server.start();http=new ProviderHttp();}
    @AfterEach void stop(){http.close();server.stop(0);executor.shutdownNow();}
    URI uri(String path){return URI.create("http://127.0.0.1:"+server.getAddress().getPort()+path);}
    @Test void retrievesBoundedJsonWithoutCredentialHeaders() {
        server.createContext("/keys",e->{assertThat(e.getRequestHeaders().getFirst("Authorization")).isNull();assertThat(e.getRequestHeaders().getFirst("Cookie")).isNull();byte[] body="{\"keys\":[]}".getBytes(StandardCharsets.UTF_8);e.getResponseHeaders().set("Content-Type","application/json;charset=UTF-8");e.sendResponseHeaders(200,body.length);e.getResponseBody().write(body);e.close();});
        assertThat(new String(http.get(uri("/keys")),StandardCharsets.UTF_8)).isEqualTo("{\"keys\":[]}");
    }
    @Test void redirectsAreNotFollowedOrRetried() {
        var hits=new AtomicInteger();server.createContext("/redirect",e->{hits.incrementAndGet();e.getResponseHeaders().set("Location",uri("/secret").toString());e.sendResponseHeaders(302,-1);e.close();});
        server.createContext("/secret",e->{hits.addAndGet(100);e.sendResponseHeaders(200,-1);e.close();});
        assertThatThrownBy(()->http.get(uri("/redirect"))).hasMessage("PROVIDER_UNAVAILABLE");assertThat(hits).hasValue(1);
    }
    @Test void oversizedOrNonJsonResponsesFailClosed() {
        server.createContext("/huge",e->{e.getResponseHeaders().set("Content-Type","application/json");e.sendResponseHeaders(200,262145);try{e.getResponseBody().write(new byte[262145]);}finally{e.close();}});
        server.createContext("/html",e->{e.getResponseHeaders().set("Content-Type","text/html");e.sendResponseHeaders(200,-1);e.close();});
        assertThatThrownBy(()->http.get(uri("/huge"))).hasMessage("PROVIDER_UNAVAILABLE");assertThatThrownBy(()->http.get(uri("/html"))).hasMessage("PROVIDER_UNAVAILABLE");
    }
    @Test void totalDeadlineIncludesSlowResponseBody() {
        server.createContext("/slow",e->{e.getResponseHeaders().set("Content-Type","application/json");e.sendResponseHeaders(200,0);try{for(int i=0;i<20;i++){e.getResponseBody().write(32);e.getResponseBody().flush();Thread.sleep(500);}}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}finally{e.close();}});
        long start=System.nanoTime();assertThatThrownBy(()->http.get(uri("/slow"))).hasMessage("PROVIDER_UNAVAILABLE");
        assertThat(java.time.Duration.ofNanos(System.nanoTime()-start)).isLessThan(java.time.Duration.ofSeconds(7));
    }
    @Test void postsFormOnceWithoutCookiesOrAuthorizationHeadersAndDoesNotFollowRedirects() {
        var hits=new AtomicInteger();
        server.createContext("/token",e->{hits.incrementAndGet();assertThat(e.getRequestMethod()).isEqualTo("POST");assertThat(e.getRequestHeaders().getFirst("Content-Type")).isEqualTo("application/x-www-form-urlencoded");assertThat(e.getRequestHeaders().getFirst("Cookie")).isNull();assertThat(e.getRequestHeaders().getFirst("Authorization")).isNull();assertThat(new String(e.getRequestBody().readAllBytes(),StandardCharsets.UTF_8)).isEqualTo("code=encoded%2Bvalue&client_secret=test");e.getResponseHeaders().set("Location",uri("/leak").toString());e.getResponseHeaders().set("Content-Type","application/json");e.sendResponseHeaders(307,-1);e.close();});
        server.createContext("/leak",e->{hits.addAndGet(100);e.sendResponseHeaders(200,-1);e.close();});
        assertThat(http.post(uri("/token"),"code=encoded%2Bvalue&client_secret=test").status()).isEqualTo(307);assertThat(hits).hasValue(1);
    }
    @Test void realHttpCodeExchangeVerifiesSignedResponseWithoutExposingProviderTokens() throws Exception {
        var now=java.time.Instant.now();var clock=java.time.Clock.fixed(now,java.time.ZoneOffset.UTC);var claims=ProviderTestTokens.claims(IdentityProvider.GOOGLE,"real-http-subject","person@gmail.com",ProviderTestTokens.NONCE,now);
        byte[] response=ProviderTestTokens.JSON.writeValueAsBytes(java.util.Map.of("access_token","test-provider-access","token_type","Bearer","expires_in",3600,"id_token",ProviderTestTokens.sign(claims)));
        server.createContext("/token",e->{e.getRequestBody().readAllBytes();e.getResponseHeaders().set("Content-Type","application/json");e.sendResponseHeaders(200,response.length);e.getResponseBody().write(response);e.close();});
        var registration=new ProviderRegistration(IdentityProvider.GOOGLE,ProviderTestTokens.CLIENT,URI.create("https://auth.example.test/callback"));
        try(var client=new ProviderCodeClient(registration,id->"test-secret",ProviderTestTokens.verifier(IdentityProvider.GOOGLE,clock),clock,(endpoint,form)->{assertThat(endpoint).isEqualTo(IdentityProvider.GOOGLE.token());return http.post(uri("/token"),form);})) {
            assertThat(client.exchange("test-code",ProviderTestTokens.NONCE,"v".repeat(43),now).subject()).isEqualTo("real-http-subject");
        }
    }
}
