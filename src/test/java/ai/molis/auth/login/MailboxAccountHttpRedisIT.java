package ai.molis.auth.login;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.LocalAccountService;
import ai.molis.auth.mail.*;
import ai.molis.auth.security.Pkce;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.SessionService;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Password-only signup and disabled legacy email entry points, including mailbox trust boundaries. */
@SpringBootTest(classes=AuthApplication.class, webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties={"auth.login.enabled=true", "auth.ephemeral.enabled=true", "auth.mail.enabled=true",
                "auth.mail.mode=inbox", "auth.mail.worker.enabled=false", "auth.issuer=http://localhost:8080",
                "auth.mail.origin=http://localhost:8080", "server.address=127.0.0.1"})
class MailboxAccountHttpRedisIT {
    private static final String AUTH="http://localhost:8080", PRODUCT="https://mailbox-product.example.test";
    private static final String PASSWORD="An original mailbox testing phrase", NEW_PASSWORD="An entirely different testing phrase";
    private static final HttpClient HTTP=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private static final JsonMapper JSON=JsonMapper.builder().build();
    @Value("${local.server.port}") int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired LocalAccountService accounts;
    @Autowired SessionService sessions;
    @Autowired MailDispatcher dispatcher;
    @Autowired MailTransport transport;
    @Autowired RedisAuthTransactions transactions;
    @MockitoSpyBean ai.molis.auth.persistence.AccountMapper accountMapper;
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p) {
        LoginHttpRedisIT.infrastructure(p);
        p.add("auth.mail.crypto.active-key-id", ()->"primary");
        p.add("auth.mail.crypto.keys.primary", ()->Base64.getEncoder().encodeToString(new byte[32]));
    }
    @AfterAll static void close() { HTTP.close(); }

    @Test void registrationUsesPasswordWithoutSendingMailAndCompletesLogin() throws Exception {
        var f=fixture(); String email=id()+"@example.test", transaction=begin(f);
        var mismatch=signup(transaction,email,PASSWORD,"different");
        assertThat(mismatch.statusCode()).isEqualTo(400);
        assertThat(json(mismatch).path("error").path("code").asText()).isEqualTo("PASSWORD_MISMATCH");
        assertThat(signup(transaction,email,"short","short").statusCode()).isEqualTo(400);
        var created=signup(transaction,email,PASSWORD,PASSWORD);
        assertThat(created.statusCode()).as(created.body()).isEqualTo(200);
        String user=jdbc.queryForObject("SELECT user_id FROM auth_user_email WHERE canonical_email=?",String.class,email);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_user_email WHERE user_id=? AND verified_at IS NULL",Integer.class,user)).isEqualTo(1);
        assertThat(accountMapper.findByVerifiedEmail(email)).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_membership WHERE user_id=? AND role='OWNER'",Integer.class,user)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email=?",Integer.class,email)).isZero();
        var complete=post("/transactions/complete",Map.of(),transaction,AUTH);
        assertThat(complete.statusCode()).as(complete.body()).isEqualTo(200);
        assertThat(json(complete).path("data").path("redirectTo").asText()).startsWith(f.redirect()+"?code=");
        assertThat(post("/transactions/password",Map.of("email",email,"password",PASSWORD),begin(f),AUTH).statusCode()).isEqualTo(200);
        assertThat(signup(begin(f),email,PASSWORD,PASSWORD).statusCode()).isEqualTo(409);
        assertThat(signup(transaction,email,PASSWORD,PASSWORD).statusCode()).isEqualTo(400);
    }
    @Test void signupRejectsOtherOriginsAndInvalidEmail() throws Exception {
        String transaction=begin(fixture()),email=id()+"@example.test";
        assertThat(post("/transactions/signup",Map.of("email",email,"password",PASSWORD,"confirmPassword",PASSWORD),transaction,PRODUCT).statusCode()).isEqualTo(403);
        assertThat(signup(transaction,"invalid",PASSWORD,PASSWORD).statusCode()).isEqualTo(400);
        assertThat(signup(transaction,email,PASSWORD,PASSWORD).statusCode()).isEqualTo(200);
    }
    @Test void oldMailRegistrationVerificationAndResetAreDisabledEvenWithMailEnabled() throws Exception {
        String transaction=begin(fixture()),secret=TokenSecrets.generate();
        var request=post("/transactions/mailbox",Map.of("email",id()+"@example.test","purpose","REGISTER","locale","en"),transaction,AUTH);
        assertThat(request.statusCode()).isEqualTo(409);
        assertThat(json(request).path("error").path("code").asText()).isEqualTo("EMAIL_FLOW_UNAVAILABLE");
        assertThat(verify(secret,secret,true,AUTH).statusCode()).isEqualTo(409);
        assertThat(register(transaction,secret,PASSWORD).statusCode()).isEqualTo(409);
        assertThat(post("/transactions/reset-password",Map.of("challenge",secret,"password",PASSWORD,"locale","en"),transaction,AUTH).statusCode()).isEqualTo(409);
    }
    @Test void unverifiedEmailDoesNotGrantInvitationOwnership() {
        String email=id()+"@example.test",user=accounts.registerWithoutMailboxVerification(email,PASSWORD,id());
        String team=id(),invitation=id();
        jdbc.update("INSERT INTO auth_space(id,name,space_type,status) VALUES(?,'Invitation boundary','TEAM','ACTIVE')",team);
        jdbc.update("INSERT INTO auth_space_invitation(id,space_id,invited_email,inviter_user_id,status,created_at,expires_at) VALUES(?,?,?,?,'PENDING',NOW(),DATE_ADD(NOW(),INTERVAL 1 DAY))",invitation,team,email,user);
        assertThat(spaces.verifiedEmails(user)).isEmpty();
        assertThat(spaces.inbox(user,"",20)).isEmpty();
        jdbc.update("UPDATE auth_user_email SET verified_at=NOW() WHERE user_id=?",user);
        assertThat(spaces.inbox(user,"",20)).isEmpty();
        assertThat(accountMapper.findByVerifiedEmail(email)).isNotNull();
    }
    @Autowired ai.molis.auth.space.SpaceMapper spaces;
    private HttpResponse<String> signup(String transaction,String email,String password,String confirmation)throws Exception {
        return post("/transactions/signup",Map.of("email",email,"password",password,"confirmPassword",confirmation),transaction,AUTH);
    }

    private Fixture fixture() {
        String application=id(),client="mailbox-"+id(),registered=id(),redirect=PRODUCT+"/callback";
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES (?,'Mailbox HTTP test','ACTIVE')",application);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES (?,?,?,'WEB','ACTIVE','account')",registered,client,application);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES (?,?)",registered,redirect);
        return new Fixture(application,client,redirect);
    }
    private String begin(Fixture f) throws Exception {
        var result=post("/transactions",Map.of("clientId",f.client(),"redirectUri",f.redirect(),"codeChallenge",Pkce.challenge("v".repeat(43)),
                "codeChallengeMethod","S256","state",TokenSecrets.generate(),"scopes",List.of("account")),null,PRODUCT);
        assertThat(result.statusCode()).as("begin response: %s",result.body()).isEqualTo(200);return json(result).path("data").path("transaction").asText();
    }
    private String mail(String transaction,String email,String purpose) throws Exception {
        var result=post("/transactions/mailbox",Map.of("email",email,"purpose",purpose,"locale","en"),transaction,PRODUCT);
        assertThat(result.statusCode()).isEqualTo(200);assertThat(result.body()).doesNotContain("deliverySecret");
        return json(result).path("data").path("challenge").asText();
    }
    private String deliveredSecret(String email) {
        String message=jdbc.queryForObject("SELECT id FROM auth_mail_outbox WHERE recipient_email = ? AND template_key IN ('VERIFY_REGISTER','VERIFY_PASSWORD_RESET')",String.class,email);
        assertThat(MailTestDelivery.dispatch(dispatcher,message)).isTrue();
        String body=((DevelopmentInbox)transport).messages().stream().filter(m->m.id().equals(message)).findFirst().orElseThrow().body();
        String link=body.lines().filter(line->line.startsWith(AUTH+"/verify-email#")).findFirst().orElseThrow();
        return URI.create(link).getFragment().split("&token=")[1];
    }
    private HttpResponse<String> verify(String challenge,String secret,boolean confirmed,String origin)throws Exception {
        return post("/mailbox/verify",Map.of("challenge",challenge,"secret",secret,"confirmed",confirmed),null,origin);
    }
    private HttpResponse<String> register(String transaction,String challenge,String password)throws Exception {
        return post("/transactions/register",Map.of("challenge",challenge,"displayName","New account","password",password,"locale","en"),transaction,PRODUCT);
    }
    private HttpResponse<String> post(String path,Object body,String token,String origin)throws Exception {
        String cookie=null;
        if(path.equals("/transactions/complete")) {
            var preview=post("/transactions/confirmation",Map.of(),token,origin);
            if(preview.statusCode()!=200)return preview;
            cookie=preview.headers().firstValue("Set-Cookie").orElseThrow().split(";",2)[0];
            body=Map.of("confirmation",json(preview).path("data").path("confirmation").asText(),"confirmed",true);
        }
        var request=HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(10)).header("Content-Type","application/json")
                .header("Origin",origin).POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
        if(token!=null)request.header(AuthHttpBoundary.TRANSACTION_HEADER,token);
        if(cookie!=null)request.header("Cookie",cookie);
        return HTTP.send(request.build(),HttpResponse.BodyHandlers.ofString());
    }
    private URI uri(String path){return URI.create("http://127.0.0.1:"+port+"/api/v1/auth"+path);}
    private static JsonNode json(HttpResponse<String> r){return JSON.readTree(r.body());}
    private static String id(){return UUID.randomUUID().toString();}
    private record Fixture(String application,String client,String redirect){}
}
