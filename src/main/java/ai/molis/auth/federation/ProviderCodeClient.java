package ai.molis.auth.federation;

import ai.molis.auth.security.Pkce;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.*;
import tools.jackson.databind.json.JsonMapper;

/**
 * Auth-owned confidential web registration. The coordinator MUST consume its Redis state before exchange.
 * No implicit flow, provider-token persistence, network retry, browser secret or HTTP controller here.
 */
public final class ProviderCodeClient implements AutoCloseable {
    private static final JsonMapper JSON=JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private final ProviderRegistration registration;
    private final ProviderClientSecret secrets;
    private final ProviderTokenVerifier verifier;
    private final Clock clock;
    private final Transport transport;
    private final ProviderHttp http;
    @FunctionalInterface interface Transport { ProviderHttp.Response post(URI uri,String form); }
    ProviderCodeClient(ProviderRegistration registration,ProviderClientSecret secrets,ProviderTokenVerifier verifier,Clock clock,Transport transport) {
        this(registration,secrets,verifier,clock,transport,null);
    }
    private ProviderCodeClient(ProviderRegistration registration,ProviderClientSecret secrets,ProviderTokenVerifier verifier,Clock clock,Transport transport,ProviderHttp http) {
        this.registration=Objects.requireNonNull(registration);this.secrets=Objects.requireNonNull(secrets);this.verifier=Objects.requireNonNull(verifier);
        this.clock=Objects.requireNonNull(clock);this.transport=Objects.requireNonNull(transport);this.http=http;
        if(!verifier.matches(registration.provider(),registration.clientId()))throw new IllegalArgumentException("Provider verifier registration mismatch");
    }
    public static ProviderCodeClient production(ProviderRegistration registration,ProviderClientSecret secrets,Clock clock) {
        var http=new ProviderHttp();ProviderTokenVerifier verifier=null;
        try { verifier=ProviderTokenVerifier.production(registration.provider(),registration.clientId(),clock);return new ProviderCodeClient(registration,secrets,verifier,clock,http::post,http); }
        catch(RuntimeException invalid){http.close();if(verifier!=null)verifier.close();throw invalid;}
    }
    ProviderRegistration registration() { return registration; }
    public URI authorize(String state,String nonce,String codeVerifier) {
        opaque(state);opaque(nonce);pkce(codeVerifier);
        var form=new LinkedHashMap<String,String>();form.put("client_id",registration.clientId());form.put("redirect_uri",registration.callback().toASCIIString());
        form.put("response_type","code");form.put("scope",registration.provider()==IdentityProvider.GOOGLE?"openid email profile":"openid email");form.put("state",state);form.put("nonce",nonce);
        if(registration.provider()==IdentityProvider.GOOGLE) {form.put("response_mode","query");form.put("code_challenge",Pkce.challenge(codeVerifier));form.put("code_challenge_method","S256");form.put("access_type","online");}
        else form.put("response_mode","form_post");
        return URI.create(registration.provider().authorization()+"?"+form(form));
    }
    public ProviderTokenVerifier.VerifiedIdentity exchange(String code,String nonce,String codeVerifier,Instant startedAt) {
        opaque(nonce);pkce(codeVerifier);
        Instant now=clock.instant();
        if(code==null||!code.matches("[!-~]{1,4096}")||startedAt==null||startedAt.isAfter(now.plusSeconds(60))||!now.isBefore(startedAt.plusSeconds(600)))throw ExternalFailure.invalid();
        String secret;
        try {secret=secrets.current(registration.clientId());if(secret==null||!secret.matches("[!-~]{1,8192}"))throw new IllegalArgumentException();}
        catch(RuntimeException failure){throw new ExternalFailure("PROVIDER_CONFIGURATION_ERROR");}
        var form=new LinkedHashMap<String,String>();form.put("grant_type","authorization_code");form.put("client_id",registration.clientId());form.put("client_secret",secret);
        form.put("redirect_uri",registration.callback().toASCIIString());form.put("code",code);if(codeVerifier!=null)form.put("code_verifier",codeVerifier);
        ProviderHttp.Response response;
        try {response=transport.post(registration.provider().token(),form(form));}
        catch(RuntimeException failure){throw ExternalFailure.unavailable();}
        if(response==null||!ProviderHttp.json(response.mediaType())||response.body().length>262144)throw ExternalFailure.unavailable();
        JsonNode body;
        try {body=JSON.readTree(response.body());if(!body.isObject())throw new IllegalArgumentException();}
        catch(RuntimeException invalid){throw ExternalFailure.unavailable();}
        if(response.status()!=200) {
            if((response.status()==400||response.status()==401)&&body.path("error").isString()) {
                if("invalid_grant".equals(body.path("error").asString()))throw new ExternalFailure("PROVIDER_CODE_REJECTED");
                if("invalid_client".equals(body.path("error").asString()))throw new ExternalFailure("PROVIDER_CONFIGURATION_ERROR");
            }
            throw ExternalFailure.unavailable();
        }
        String access=text(body,"access_token"),idToken=text(body,"id_token"),type=text(body,"token_type");var expiry=body.path("expires_in");
        if(body.has("error")||!"Bearer".equalsIgnoreCase(type)||access==null||!access.matches("[!-~]{1,8192}")||idToken==null||idToken.length()>16384
                ||!expiry.isIntegralNumber()||!expiry.canConvertToLong()||expiry.asLong()<=0||expiry.asLong()>86400)throw new ExternalFailure("PROVIDER_RESPONSE_INVALID");
        // The only value returned is a verified identity. Never return provider access/refresh tokens to products.
        return verifier.verify(idToken,nonce,startedAt,access);
    }
    private void pkce(String verifier) {
        if(registration.provider()==IdentityProvider.GOOGLE) {try{Pkce.challenge(verifier);}catch(IllegalArgumentException invalid){throw ExternalFailure.invalid();}}
        else if(verifier!=null)throw ExternalFailure.invalid(); // Apple discovery does not advertise PKCE; don't pretend it is enforced.
    }
    private static void opaque(String value){if(value==null||!value.matches("[A-Za-z0-9_-]{43}"))throw ExternalFailure.invalid();}
    private static String text(JsonNode body,String key){var value=body.get(key);return value!=null&&value.isString()?value.asString():null;}
    static String form(Map<String,String> values){return values.entrySet().stream().map(e->encode(e.getKey())+"="+encode(e.getValue())).collect(Collectors.joining("&"));}
    private static String encode(String value){return URLEncoder.encode(value,StandardCharsets.UTF_8);}
    @Override public void close(){if(http!=null)http.close();verifier.close();}
}
