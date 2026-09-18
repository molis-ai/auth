package ai.molis.auth.platform;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.login.LoginClientPolicy;
import ai.molis.auth.persistence.MySqlTestDataSources;
import ai.molis.auth.verification.RedisRateLimiter;
import java.net.URI;
import java.net.http.*;
import java.time.Clock;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.*;
import org.springframework.test.context.bean.override.mockito.*;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Disposable SQL fixtures; bootstrap creates configuration only, never a user or admin credential. */
@SpringBootTest(classes=AuthApplication.class,webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties={"auth.login.enabled=true","auth.ephemeral.enabled=false","auth.console.enabled=true",
                "auth.console.client-id=auth-it-console-v1","auth.issuer=http://localhost:8080"})
class ConsoleRegistrationIT {
    @Autowired ConsoleRegistration console;
    @Autowired ConsoleRegistrationMapper registrations;
    @MockitoSpyBean PlatformMapper platforms;
    @Autowired LoginClientPolicy policy;
    @Autowired Clock clock;
    @Autowired PlatformTransactionManager manager;
    @Autowired JdbcTemplate jdbc;
    @MockitoBean RedisRateLimiter unusedLoginLimiter;
    @Value("${local.server.port}") int port;
    ConsoleRegistrationMapper.Binding original;
    private static final HttpClient HTTP=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p){
        p.add("spring.datasource.url",ConsoleRegistrationIT::url);
        p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));
        p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
    }
    private static String url(){String url=System.getProperty("auth.it.jdbc-url","");
        if(!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))throw new IllegalArgumentException("Disposable local database required");return url;}
    @BeforeEach void saveBinding(){original=registrations.binding();assertThat(original).isNotNull();}
    @AfterEach void restoreIsolatedFixture(){
        jdbc.update("UPDATE auth_console_registration SET application_id=?,login_client_id=? WHERE id='console'",original.applicationId(),original.loginClientId());
        jdbc.update("UPDATE auth_application SET status='ACTIVE' WHERE id=?",original.applicationId());
        jdbc.update("UPDATE auth_login_client SET status='ACTIVE' WHERE id=?",original.loginClientId());
        verifyNoInteractions(unusedLoginLimiter);
    }
    @AfterAll static void close(){HTTP.close();}
    @Test void startupRunnerRegistersConsoleWithoutGrantingAnyBusinessActions(){
        assertThat(console.configuration().enabled()).isTrue();assertThat(console.configuration().clientId()).isEqualTo("auth-it-console-v1");
        assertThat(console.configuration().redirectUri()).isEqualTo("http://localhost:8080/console/callback");
        assertThat(platforms.actions(original.applicationId())).isEmpty();
        assertThat(jdbc.queryForObject("SELECT actor_user_id FROM auth_audit_event WHERE action='platform.console.initialize' AND application_id=?",String.class,original.applicationId())).isNull();
    }
    @Test void freshInitializationCreatesOnlyPublicConfigurationAndIsRepeatable(){
        long users=count("auth_user"),passwords=count("auth_local_credential"),serviceSecrets=count("auth_service_credential"),applications=count("auth_application");
        freshAnchor();String client="bootstrap-"+UUID.randomUUID();var boot=bootstrap(client);boot.initialize();boot.initialize();
        assertThat(count("auth_user")).isEqualTo(users);assertThat(count("auth_local_credential")).isEqualTo(passwords);assertThat(count("auth_service_credential")).isEqualTo(serviceSecrets);
        assertThat(count("auth_application")).isEqualTo(applications+1);assertThat(boot.configuration().enabled()).isTrue();
        var binding=registrations.binding();assertThat(platforms.actions(binding.applicationId())).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE action='platform.console.initialize' AND application_id=?",Integer.class,binding.applicationId())).isEqualTo(1);
    }
    @Test void independentDatabaseConnectionsSerializeConcurrentBootstrap()throws Exception{
        freshAnchor();String client="race-console-"+UUID.randomUUID();var first=bootstrap(client);var second=independent(client);long before=count("auth_application");
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            var one=executor.submit(first::initialize);var two=executor.submit(second::initialize);one.get(15,TimeUnit.SECONDS);two.get(15,TimeUnit.SECONDS);
        }
        assertThat(count("auth_application")).isEqualTo(before+1);assertThat(first.configuration()).isEqualTo(second.configuration());
    }
    @Test void auditFailureRollsBackTheBindingApplicationAndClient(){
        freshAnchor();String client="rollback-console-"+UUID.randomUUID();long before=count("auth_application");
        doThrow(new DataAccessResourceFailureException("private bootstrap audit detail")).when(platforms).audit(any());
        assertThatThrownBy(()->bootstrap(client).initialize()).isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(count("auth_application")).isEqualTo(before);assertThat(registrations.binding()).isNull();assertThat(platforms.client(client)).isNull();
    }
    @Test void restartDoesNotReenableDisabledConfigurationOrOverwriteEdits(){
        jdbc.update("UPDATE auth_application SET status='DISABLED' WHERE id=?",original.applicationId());
        jdbc.update("UPDATE auth_login_client SET status='DISABLED' WHERE id=?",original.loginClientId());
        console.initialize();assertThat(console.configuration().enabled()).isFalse();
        assertThat(platforms.application(original.applicationId()).status()).isEqualTo("DISABLED");
        assertThat(platforms.client("auth-it-console-v1").status()).isEqualTo("DISABLED");
    }
    @Test void existingClientCannotBeAdoptedAndClientIdChangesAreNotSilent(){
        assertThatThrownBy(()->bootstrap("different-console-"+UUID.randomUUID()).initialize()).isInstanceOf(IllegalStateException.class);
        freshAnchor();assertThatThrownBy(console::initialize).isInstanceOf(IllegalStateException.class);
        assertThat(registrations.binding()).isNull();assertThat(platforms.client("auth-it-console-v1").id()).isEqualTo(original.loginClientId());
    }
    @Test void publicConfigurationAndCallbackPageExposeNoAdministratorOrCredentials()throws Exception{
        var config=get("/api/v1/auth/ui-configuration");assertThat(config.statusCode()).isEqualTo(200);
        var json=JsonMapper.builder().build().readTree(config.body()).path("data").path("console");assertThat(json.path("enabled").asBoolean()).isTrue();
        assertThat(config.body()).doesNotContain("admin-user-ids","secret","password");
        var callback=get("/console/callback?code="+"a".repeat(43)+"&state="+"b".repeat(43));
        boolean packaged=new org.springframework.core.io.ClassPathResource("static/auth-ui/index.html").exists();
        assertThat(callback.statusCode()).isEqualTo(packaged?200:503);assertThat(callback.body()).doesNotContain("a".repeat(43));
        assertThat(callback.headers().firstValue("Cache-Control").orElseThrow()).isEqualTo("no-store");
        assertThat(callback.headers().firstValue("Content-Security-Policy").orElseThrow()).contains("frame-ancestors 'none'");
        assertThat(get("/login?code=unrelated").statusCode()).isEqualTo(400);
    }
    private void freshAnchor(){jdbc.update("UPDATE auth_console_registration SET application_id=NULL,login_client_id=NULL WHERE id='console'");}
    private long count(String table){return jdbc.queryForObject("SELECT COUNT(*) FROM "+table,Long.class);}
    private ConsoleRegistration bootstrap(String client){return new ConsoleRegistration(registrations,platforms,policy,client,clock,manager);}
    private ConsoleRegistration independent(String client)throws Exception{
        var source=MySqlTestDataSources.create(url(),System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"),System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
        var factory=new org.mybatis.spring.SqlSessionFactoryBean();factory.setDataSource(source);
        var config=new org.apache.ibatis.session.Configuration();config.setMapUnderscoreToCamelCase(true);config.setLocalCacheScope(org.apache.ibatis.session.LocalCacheScope.STATEMENT);config.setCacheEnabled(false);
        config.addMapper(ConsoleRegistrationMapper.class);config.addMapper(PlatformMapper.class);factory.setConfiguration(config);factory.afterPropertiesSet();
        var sql=new org.mybatis.spring.SqlSessionTemplate(factory.getObject());
        return new ConsoleRegistration(sql.getMapper(ConsoleRegistrationMapper.class),sql.getMapper(PlatformMapper.class),policy,client,clock,new org.springframework.jdbc.datasource.DataSourceTransactionManager(source));
    }
    private HttpResponse<String> get(String path)throws Exception{return HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path)).timeout(Duration.ofSeconds(10)).GET().build(),HttpResponse.BodyHandlers.ofString());}
}
