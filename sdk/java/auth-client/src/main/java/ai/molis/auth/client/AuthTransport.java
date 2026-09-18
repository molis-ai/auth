package ai.molis.auth.client;

import java.net.URI;
import java.time.Duration;
import java.util.Map;

/** Trusted transport extension point, e.g. a deployment-owned mTLS client. Must not retry, redirect or log secrets. */
@FunctionalInterface
public interface AuthTransport {
    Response post(URI uri, Map<String,String> headers, byte[] body, Duration timeout);
    record Response(int status, String contentType, byte[] body) {
        @Override public String toString() { return "Response[status="+status+", body redacted]"; }
    }
}
