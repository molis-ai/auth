package ai.molis.auth.federation;

import ai.molis.auth.security.Pkce;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static ai.molis.auth.federation.ProviderTestTokens.*;

class ProviderCodeClientTests {
    static final Instant NOW=Instant.parse("2026-09-15T00:00:00Z");static final Clock CLOCK=Clock.fixed(NOW,ZoneOffset.UTC);
    static final String VERIFIER="v".repeat(43),STATE="s".repeat(43),ACCESS="provider-access-only";
    static final URI CALLBACK=URI.create("https://auth.example.test/provider/callback");
    static ProviderCodeClient client(IdentityProvider p,ProviderClientSecret secrets,ProviderCodeClient.Transport transport) {
        return new ProviderCodeClient(new ProviderRegistration(p,CLIENT,CALLBACK),secrets,verifier(p,CLOCK),CLOCK,transport);
    }
    static Map<String,String> form(String text) {var values=new LinkedHashMap<String,String>();for(String part:text.split("&")){var pair=part.split("=",2);String key=URLDecoder.decode(pair[0],StandardCharsets.UTF_8);assertThat(values.put(key,URLDecoder.decode(pair[1],StandardCharsets.UTF_8))).isNull();}return values;}
    static Map<String,Object> response(IdentityProvider provider) throws Exception {
        var claims=claims(provider,"provider-subject","person@gmail.com",NONCE,NOW);
        claims.put("at_hash",Base64.getUrlEncoder().withoutPadding().encodeToString(Arrays.copyOf(MessageDigest.getInstance("SHA-256").digest(ACCESS.getBytes(StandardCharsets.US_ASCII)),16)));
        return new LinkedHashMap<>(Map.of("id_token",sign(claims),"access_token",ACCESS,"token_type","Bearer","expires_in",3600,"refresh_token","never-return-or-persist"));
    }
    static ProviderHttp.Response json(int status,Object body){return new ProviderHttp.Response(status,"application/json",JSON.writeValueAsBytes(body));}

    @Test void googleAuthorizationUsesCodePkceStateNonceAndNoSecretOrOfflineGrant() {
        var secretCalls=new AtomicInteger();try(var c=client(IdentityProvider.GOOGLE,id->{secretCalls.incrementAndGet();return "secret";},(uri,form)->{throw new AssertionError();})) {
            var url=c.authorize(STATE,NONCE,VERIFIER);assertThat(url.toString()).startsWith("https://accounts.google.com/o/oauth2/v2/auth?");var p=form(url.getRawQuery());
            assertThat(p).containsEntry("client_id",CLIENT).containsEntry("redirect_uri",CALLBACK.toString()).containsEntry("response_type","code")
                    .containsEntry("state",STATE).containsEntry("nonce",NONCE).containsEntry("code_challenge",Pkce.challenge(VERIFIER)).containsEntry("code_challenge_method","S256").containsEntry("access_type","online");
            assertThat(p).doesNotContainKeys("client_secret","code_verifier","id_token");assertThat(secretCalls).hasValue(0);
        }
    }
    @Test void appleAuthorizationUsesFormPostAndDoesNotClaimUnsupportedPkce() {
        try(var c=client(IdentityProvider.APPLE,id->"secret",(uri,form)->{throw new AssertionError();})) {
            var p=form(c.authorize(STATE,NONCE,null).getRawQuery());assertThat(p).containsEntry("response_mode","form_post").containsEntry("response_type","code").containsEntry("scope","openid email");
            assertThat(p).doesNotContainKeys("code_challenge","code_challenge_method","client_secret");
            assertThatThrownBy(()->c.authorize(STATE,NONCE,VERIFIER)).hasMessage("PROVIDER_IDENTITY_INVALID");
        }
    }
    @Test void googleExchangeEncodesFormUsesFixedEndpointAndReturnsOnlyVerifiedIdentity() throws Exception {
        var calls=new AtomicInteger();var payload=response(IdentityProvider.GOOGLE);
        try(var c=client(IdentityProvider.GOOGLE,id->"secret&plus+equals=",(uri,body)->{
            calls.incrementAndGet();assertThat(uri).isEqualTo(IdentityProvider.GOOGLE.token());
            assertThat(form(body)).containsExactlyInAnyOrderEntriesOf(Map.of("grant_type","authorization_code","client_id",CLIENT,"client_secret","secret&plus+equals=","redirect_uri",CALLBACK.toString(),"code","code+/=value","code_verifier",VERIFIER));return json(200,payload);
        })) {
            var identity=c.exchange("code+/=value",NONCE,VERIFIER,NOW);assertThat(identity.subject()).isEqualTo("provider-subject");assertThat(identity.toString()).doesNotContain(ACCESS,"never-return-or-persist");assertThat(calls).hasValue(1);
        }
    }
    @Test void appleExchangeUsesConfidentialRegistrationWithoutPkce() throws Exception {
        var payload=response(IdentityProvider.APPLE);
        try(var c=client(IdentityProvider.APPLE,id->"signed-client-assertion",(uri,body)->{assertThat(uri).isEqualTo(IdentityProvider.APPLE.token());assertThat(form(body)).containsEntry("client_secret","signed-client-assertion").doesNotContainKey("code_verifier");return json(200,payload);})) {
            assertThat(c.exchange("apple-code",NONCE,null,NOW).provider()).isEqualTo(IdentityProvider.APPLE);
        }
    }
    @Test void invalidGrantConfigurationAndOutageRemainDistinctWithoutRetryOrRawErrors() {
        for(var entry:Map.of("invalid_grant","PROVIDER_CODE_REJECTED","invalid_client","PROVIDER_CONFIGURATION_ERROR","other","PROVIDER_UNAVAILABLE").entrySet()) {
            var calls=new AtomicInteger();try(var c=client(IdentityProvider.GOOGLE,id->"secret",(uri,body)->{calls.incrementAndGet();return json(400,Map.of("error",entry.getKey(),"error_description","sensitive provider detail"));})) {
                assertThatThrownBy(()->c.exchange("code",NONCE,VERIFIER,NOW)).hasMessage(entry.getValue()).hasNoCause();assertThat(calls).hasValue(1);
            }
        }
        var calls=new AtomicInteger();try(var c=client(IdentityProvider.GOOGLE,id->"secret",(uri,body)->{calls.incrementAndGet();throw new IllegalStateException("private-code-and-secret");})) {
            assertThatThrownBy(()->c.exchange("code",NONCE,VERIFIER,NOW)).hasMessage("PROVIDER_UNAVAILABLE").hasNoCause();assertThat(calls).hasValue(1);
        }
    }
    @Test void malformedResponsesCannotBecomeIdentity() throws Exception {
        for(String field:List.of("access_token","id_token","token_type","expires_in")) {
            var payload=response(IdentityProvider.GOOGLE);payload.remove(field);
            try(var c=client(IdentityProvider.GOOGLE,id->"secret",(uri,body)->json(200,payload))) {assertThatThrownBy(()->c.exchange("code",NONCE,VERIFIER,NOW)).hasMessage("PROVIDER_RESPONSE_INVALID");}
        }
        var payload=response(IdentityProvider.GOOGLE);payload.put("access_token","different-access-token");
        try(var c=client(IdentityProvider.GOOGLE,id->"secret",(uri,body)->json(200,payload))) {assertThatThrownBy(()->c.exchange("code",NONCE,VERIFIER,NOW)).hasMessage("PROVIDER_IDENTITY_INVALID");}
        for(String malformed:List.of("{\"id_token\":\"one\",\"id_token\":\"two\"}","{} {}","[]"))
            try(var c=client(IdentityProvider.GOOGLE,id->"secret",(uri,body)->new ProviderHttp.Response(200,"application/json",malformed.getBytes(StandardCharsets.UTF_8)))) {
                assertThatThrownBy(()->c.exchange("code",NONCE,VERIFIER,NOW)).hasMessage("PROVIDER_UNAVAILABLE");
            }
    }
    @Test void signedAtHashRequiresMatchingAccessTokenAndCannotBeIgnored() throws Exception {
        var payload=response(IdentityProvider.GOOGLE);String signed=(String)payload.get("id_token");
        try(var v=verifier(IdentityProvider.GOOGLE,CLOCK)) {
            assertThatThrownBy(()->v.verify(signed,NONCE,NOW)).hasMessage("PROVIDER_IDENTITY_INVALID");
            assertThat(v.verify(signed,NONCE,NOW,ACCESS).subject()).isEqualTo("provider-subject");
        }
    }
    @Test void invalidInputOrRegistrationNeverTransmitsCredentials() {
        var calls=new AtomicInteger();try(var c=client(IdentityProvider.GOOGLE,id->{calls.incrementAndGet();return "secret";},(uri,body)->{throw new AssertionError();})) {
            for(String code:Arrays.asList(null,"","line\nbreak","x".repeat(4097)))assertThatThrownBy(()->c.exchange(code,NONCE,VERIFIER,NOW)).hasMessage("PROVIDER_IDENTITY_INVALID");
            assertThatThrownBy(()->c.exchange("code",NONCE,VERIFIER,NOW.minusSeconds(600))).hasMessage("PROVIDER_IDENTITY_INVALID");
            assertThatThrownBy(()->c.exchange("code",NONCE,null,NOW)).hasMessage("PROVIDER_IDENTITY_INVALID");assertThat(calls).hasValue(0);
        }
        for(String callback:List.of("http://auth.example/callback","https://user:pass@auth.example/callback","https://auth.example/callback?q=1","https://auth.example/callback#fragment","https://auth.example/a/../callback"))
            assertThatThrownBy(()->new ProviderRegistration(IdentityProvider.GOOGLE,CLIENT,URI.create(callback))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(()->new ProviderRegistration(IdentityProvider.APPLE,CLIENT,URI.create("https://127.0.0.1/callback"))).isInstanceOf(IllegalArgumentException.class);
    }
    @Test void rotatedSecretsAreReadPerExchangeButNeverRetriedWithinAnExchange() throws Exception {
        var index=new AtomicInteger();var seen=new ArrayList<String>();var payload=response(IdentityProvider.GOOGLE);
        try(var c=client(IdentityProvider.GOOGLE,id->"secret-"+index.incrementAndGet(),(uri,body)->{seen.add(form(body).get("client_secret"));return json(200,payload);})) {
            c.exchange("first-code",NONCE,VERIFIER,NOW);c.exchange("second-code",NONCE,VERIFIER,NOW);assertThat(seen).containsExactly("secret-1","secret-2");
        }
    }
}
