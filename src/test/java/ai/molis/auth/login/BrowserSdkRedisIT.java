package ai.molis.auth.login;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.LocalAccountService;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.assertThat;

/** Actual compiled JS SDK -> HTTP -> Redis/MySQL. Simulates navigation, NOT a browser/Cookie-policy test. */
@EnabledIfSystemProperty(named="auth.it.browser-sdk",matches="true")
@SpringBootTest(classes=AuthApplication.class,webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties={"auth.login.enabled=true","auth.ephemeral.enabled=true","auth.issuer=http://localhost:8080"})
class BrowserSdkRedisIT {
    @Value("${local.server.port}") int port;
    @Autowired LocalAccountService accounts;
    @Autowired JdbcTemplate jdbc;
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p) {
        p.add("spring.datasource.url",()->{
            String value=System.getProperty("auth.it.jdbc-url","");
            if(!value.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?")) throw new IllegalArgumentException("Disposable local database required");
            return value;
        });
        p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));
        p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
        p.add("spring.data.redis.host",()->"127.0.0.1");
        p.add("spring.data.redis.port",()->{
            int value=Integer.parseInt(System.getProperty("auth.it.redis-port","0"));
            if(value<1024||value>65535||value==6379)throw new IllegalArgumentException("Dedicated Redis port required");
            return value;
        });
        p.add("spring.data.redis.username",()->"");p.add("spring.data.redis.password",()->"");p.add("spring.data.redis.ssl.enabled",()->false);
    }
    @Test void compiledBrowserSdkUsesActualLoginRefreshAndLogoutEndpoints() throws Exception {
        String app=id(),registered=id(),client="sdk-"+id(),email=id()+"@example.test";
        String password="Independent SDK testing phrase",redirect="http://127.0.0.1:41980/callback";
        String user=accounts.registerAfterMailboxVerification(id(),email,"SDK HTTP fixture",password,"en",id());
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES (?,'SDK HTTP fixture','ACTIVE')",app);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES (?,?,?,'WEB','ACTIVE','account')",registered,client,app);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES (?,?)",registered,redirect);
        assertThat(Files.isRegularFile(Path.of("sdk/browser/dist/index.js"))).as("Build the actual SDK using -Pbrowser-sdk").isTrue();
        var process=new ProcessBuilder("node","sdk/browser/tests/live.mjs").redirectErrorStream(true).start();
        try {
            var fixture=Map.of("fixture","auth-disposable-sdk-test","base","http://127.0.0.1:"+port,"issuer","http://localhost:8080",
                    "clientId",client,"redirectUri",redirect,"email",email,"password",password,"userId",user);
            try(var input=process.getOutputStream()){input.write(JsonMapper.builder().build().writeValueAsBytes(fixture));}
            assertThat(process.waitFor(45,TimeUnit.SECONDS)).as("SDK subprocess deadline").isTrue();
            String output=new String(process.getInputStream().readAllBytes(),StandardCharsets.UTF_8);
            assertThat(process.exitValue()).as(output).isZero();assertThat(output).contains("SDK_LIVE_OK:");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE target_user_id=? AND action IN ('session.logout.current','session.logout.all')",Integer.class,user)).isEqualTo(2);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=? AND revoked_at IS NULL",Integer.class,user)).isZero();
        } finally {if(process.isAlive())process.destroyForcibly();}
    }
    private static String id(){return UUID.randomUUID().toString();}
}
