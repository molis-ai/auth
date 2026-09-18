package ai.molis.auth.login;

import ai.molis.auth.oauth.ClientRegistryMapper;
import ai.molis.auth.security.Pkce;
import java.net.URI;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "auth.login.enabled", havingValue = "true")
public final class LoginClientPolicy {
    private final ClientRegistryMapper clients;
    private final String authOrigin;
    public LoginClientPolicy(ClientRegistryMapper clients, @Value("${auth.issuer}") String issuer) {
        this.clients = clients; this.authOrigin = origin(issuer);
        if (!issuer.equals(authOrigin) && !issuer.equals(authOrigin + "/")) throw new IllegalArgumentException("Login UI requires a root Auth origin");
    }
    public RedisAuthTransactions.Context begin(String clientId, String redirect, String challenge, String method,
            String state, Set<String> scopes, boolean forceLogin, String requestOrigin) {
        if (clientId == null || clientId.length() > 100 || redirect == null || redirect.length() > 1024
                || !"S256".equals(method) || !Pkce.validChallenge(challenge) || state == null
                || !state.matches("[A-Za-z0-9_-]{22,128}") || scopes == null || scopes.isEmpty()
                || !Set.of("account", "profile").containsAll(scopes)) throw new LoginFailure(400, "INVALID_REQUEST");
        var client = clients.findByClientId(clientId);
        if (client == null || !client.clientId().equals(clientId)) throw new LoginFailure(400, "INVALID_CLIENT");
        var context = new RedisAuthTransactions.Context(UUID.randomUUID().toString(), clientId, client.clientType(),
                redirect, challenge, state, scopes, forceLogin || !"WEB".equals(client.clientType()));
        validate(context, requestOrigin);
        return context;
    }
    public void validate(RedisAuthTransactions.Context context, String requestOrigin) {
        var client = clients.findByClientId(context.clientId());
        if (client == null || !client.clientId().equals(context.clientId()) || !client.clientType().equals(context.clientType())
                || !clients.redirects(client.id()).contains(context.redirectUri())
                || !Set.copyOf(Arrays.asList(client.allowedScopes().split(" "))).containsAll(context.scopes()))
            throw new LoginFailure(400, "INVALID_CLIENT");
        URI callback;
        try { callback = URI.create(context.redirectUri()); }
        catch (IllegalArgumentException invalid) { throw new LoginFailure(400, "INVALID_REDIRECT"); }
        if (!callback.isAbsolute() || callback.isOpaque() || callback.getFragment() != null || callback.getUserInfo() != null
                || callback.getHost() == null) throw new LoginFailure(400, "INVALID_REDIRECT");
        boolean http = "http".equals(callback.getScheme()), https = "https".equals(callback.getScheme());
        if (("WEB".equals(context.clientType()) && !(https || (http && loopback(callback.getHost()))))
                || (http && !loopback(callback.getHost()))) throw new LoginFailure(400, "INVALID_REDIRECT");
        if (callback.getRawQuery() != null) {
            for (String entry : callback.getRawQuery().split("&")) {
                String name = java.net.URLDecoder.decode(entry.split("=", 2)[0], java.nio.charset.StandardCharsets.UTF_8);
                if (Set.of("code", "state", "error").contains(name)) throw new LoginFailure(400, "INVALID_REDIRECT");
            }
        }
        if (requestOrigin != null && !requestOrigin.equals(authOrigin)
                && !("WEB".equals(context.clientType()) && requestOrigin.equals(origin(context.redirectUri()))))
            throw new LoginFailure(403, "ORIGIN_NOT_ALLOWED");
    }
    public boolean allowedCorsOrigin(String value) {
        if (value.equals(authOrigin)) return true;
        return clients.activeWebRedirects().stream().anyMatch(redirect -> {
            try { return value.equals(origin(redirect)); } catch (IllegalArgumentException invalid) { return false; }
        });
    }
    public void requireAuthOrigin(String requestOrigin) {
        if (!authOrigin.equals(requestOrigin)) throw new LoginFailure(403, "AUTH_ORIGIN_REQUIRED");
    }
    /** Bearer APIs may be called only from the token client's current WEB origins or Auth itself. */
    public void requireUserClientOrigin(String clientId, String requestOrigin) {
        if (requestOrigin == null || authOrigin.equals(requestOrigin)) return;
        var client = clients.findByClientId(clientId);
        if (client == null || !"WEB".equals(client.clientType()) || !clients.redirects(client.id()).stream().anyMatch(redirect -> {
            try { return requestOrigin.equals(origin(redirect)); } catch (IllegalArgumentException invalid) { return false; }
        })) throw new LoginFailure(403, "ORIGIN_NOT_ALLOWED");
    }
    public String authOrigin() { return authOrigin; }
    public boolean localDevelopment() { return authOrigin.startsWith("http://") && loopback(URI.create(authOrigin).getHost()); }
    public static boolean loopback(String host) { return Set.of("localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1").contains(host == null ? "" : host); }
    public static String origin(String value) {
        URI uri = URI.create(value);
        if (uri.getHost() == null || !("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())))
            throw new IllegalArgumentException("Invalid HTTP origin");
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
        int port = uri.getPort();
        boolean defaultPort = port == -1 || (port == 443 && uri.getScheme().equals("https")) || (port == 80 && uri.getScheme().equals("http"));
        return uri.getScheme() + "://" + host + (defaultPort ? "" : ":" + port);
    }
}
