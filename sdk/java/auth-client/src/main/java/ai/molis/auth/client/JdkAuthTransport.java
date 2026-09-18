package ai.molis.auth.client;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.Flow.Subscription;

/** No ambient cookies/authenticator, no redirects, bounded body and total response deadline. */
public final class JdkAuthTransport implements AuthTransport, AutoCloseable {
    static final int MAX_BYTES=262144;
    private final HttpClient client;
    public JdkAuthTransport(AuthOptions options) {
        this(HttpClient.newBuilder().connectTimeout(options.connectTimeout()).followRedirects(HttpClient.Redirect.NEVER).build());
    }
    public JdkAuthTransport(HttpClient client) {
        if(client==null||client.followRedirects()!=HttpClient.Redirect.NEVER||client.cookieHandler().isPresent()||client.authenticator().isPresent())
            throw new AuthFailure(AuthFailure.Kind.INVALID_INPUT);
        this.client=client;
    }
    @Override public Response post(URI uri,Map<String,String> headers,byte[] body,Duration timeout) {
        var builder=HttpRequest.newBuilder(uri).timeout(timeout).POST(HttpRequest.BodyPublishers.ofByteArray(body));headers.forEach(builder::header);
        var future=client.sendAsync(builder.build(),ignored->new LimitedBody());
        try {
            var result=future.get(timeout.toMillis(),TimeUnit.MILLISECONDS);
            return new Response(result.statusCode(),result.headers().firstValue("Content-Type").orElse(""),result.body());
        } catch(InterruptedException interrupted) { future.cancel(true);Thread.currentThread().interrupt();throw new AuthFailure(AuthFailure.Kind.INTERRUPTED); }
        catch(ExecutionException|TimeoutException|CancellationException unavailable) { future.cancel(true);throw new AuthFailure(AuthFailure.Kind.UNAVAILABLE); }
    }
    @Override public void close() { client.shutdownNow(); }
    private static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result=new CompletableFuture<>();
        private final ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        private Subscription subscription;
        @Override public CompletionStage<byte[]> getBody(){return result;}
        @Override public void onSubscribe(Subscription value){subscription=value;value.request(1);}
        @Override public void onNext(List<ByteBuffer> buffers){
            for(var buffer:buffers){if(buffer.remaining()>MAX_BYTES-bytes.size()){subscription.cancel();result.completeExceptionally(new IllegalStateException("Response limit"));return;}
                byte[] chunk=new byte[buffer.remaining()];buffer.get(chunk);bytes.writeBytes(chunk);}
            subscription.request(1);
        }
        @Override public void onError(Throwable ignored){result.completeExceptionally(new IllegalStateException("Transport failed"));}
        @Override public void onComplete(){result.complete(bytes.toByteArray());}
    }
}
