package ai.molis.auth.federation;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.Flow;

/** Provider HTTPS transport. Total body deadline, byte cap, no redirects/cookies/authenticator/retry. */
final class ProviderHttp implements AutoCloseable {
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NEVER).build();
    byte[] get(URI uri) {
        var request=HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5)).header("Accept","application/json").GET().build();
        var response=send(request);
        if(response.status()!=200||!json(response.mediaType()))throw ExternalFailure.unavailable();
        return response.body();
    }
    Response post(URI uri,String form) {
        return send(HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5)).header("Accept","application/json")
                .header("Content-Type","application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form,java.nio.charset.StandardCharsets.UTF_8)).build());
    }
    private Response send(HttpRequest request) {
        var future=http.sendAsync(request,info -> new LimitedBody());
        try {
            var response=future.get(5,TimeUnit.SECONDS);
            String type=response.headers().firstValue("Content-Type").orElse("").split(";",2)[0].strip();
            return new Response(response.statusCode(),type,response.body());
        } catch(InterruptedException interrupted) { future.cancel(true);Thread.currentThread().interrupt();throw ExternalFailure.unavailable(); }
        catch(ExecutionException|TimeoutException failure) { future.cancel(true);throw ExternalFailure.unavailable(); }
    }
    static boolean json(String type){return type!=null&&(type.equalsIgnoreCase("application/json")||type.equalsIgnoreCase("application/jwk-set+json"));}
    record Response(int status,String mediaType,byte[] body) {
        Response { body=body.clone(); }
        @Override public byte[] body(){return body.clone();}
        @Override public String toString(){return "ProviderResponse[status="+status+", REDACTED]";}
    }
    @Override public void close() { http.shutdownNow(); }
    private static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result=new CompletableFuture<>();
        private final ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        private Flow.Subscription subscription;
        public CompletionStage<byte[]> getBody() { return result; }
        public void onSubscribe(Flow.Subscription value) { if(subscription!=null) { value.cancel();return; } subscription=value;value.request(1); }
        public void onNext(List<ByteBuffer> buffers) {
            for(var buffer:buffers) {
                if(buffer.remaining()>262144-bytes.size()) { subscription.cancel();result.completeExceptionally(ExternalFailure.unavailable());return; }
                byte[] part=new byte[buffer.remaining()];buffer.get(part);bytes.writeBytes(part);
            }
            subscription.request(1);
        }
        public void onError(Throwable ignored) { result.completeExceptionally(ExternalFailure.unavailable()); }
        public void onComplete() { result.complete(bytes.toByteArray()); }
    }
}
