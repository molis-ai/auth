package ai.molis.auth.client;

import java.net.URI;
import java.time.Duration;
import java.util.Set;

public record AuthOptions(URI issuer, boolean allowLoopbackHttp, Duration connectTimeout, Duration requestTimeout) {
    public AuthOptions {
        if(issuer==null||issuer.getHost()==null||issuer.getUserInfo()!=null||issuer.getQuery()!=null||issuer.getFragment()!=null
                ||!(issuer.getRawPath().isEmpty()||issuer.getRawPath().equals("/"))||issuer.getPort()==0||issuer.getPort()>65535)
            throw new AuthFailure(AuthFailure.Kind.INVALID_INPUT);
        if(!"https".equals(issuer.getScheme())&&!(allowLoopbackHttp&&"http".equals(issuer.getScheme())
                &&Set.of("localhost","127.0.0.1","[::1]").contains(issuer.getHost())))throw new AuthFailure(AuthFailure.Kind.INVALID_INPUT);
        bounded(connectTimeout);bounded(requestTimeout);
    }
    public static AuthOptions production(URI issuer) { return new AuthOptions(issuer,false,Duration.ofSeconds(3),Duration.ofSeconds(5)); }
    private static void bounded(Duration value) { if(value==null||value.compareTo(Duration.ofMillis(50))<0||value.compareTo(Duration.ofSeconds(30))>0)throw new AuthFailure(AuthFailure.Kind.INVALID_INPUT); }
}
