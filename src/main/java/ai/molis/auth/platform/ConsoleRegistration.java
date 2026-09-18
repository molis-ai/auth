package ai.molis.auth.platform;

import ai.molis.auth.login.LoginClientPolicy;
import java.time.Clock;
import java.time.temporal.ChronoUnit;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import org.springframework.transaction.*;
import org.springframework.transaction.support.TransactionTemplate;

/** Deployment opt-in bootstrap. Creates only a public client/application, never a user or administrator. */
@Component
@ConditionalOnProperty(name="auth.console.enabled",havingValue="true")
public final class ConsoleRegistration implements ApplicationRunner {
    private final ConsoleRegistrationMapper registrations;
    private final PlatformMapper platforms;
    private final String clientId,redirect;
    private final Clock clock;
    private final TransactionTemplate transaction;
    public ConsoleRegistration(ConsoleRegistrationMapper registrations,PlatformMapper platforms,LoginClientPolicy policy,
            @Value("${auth.console.client-id:molis-auth-console}") String clientId,Clock clock,PlatformTransactionManager manager){
        if(clientId==null||!clientId.matches("[A-Za-z0-9][A-Za-z0-9_.-]{0,99}")||clientId.startsWith("svc_"))throw new IllegalArgumentException("Invalid console client ID");
        this.registrations=registrations;this.platforms=platforms;this.clientId=clientId;
        this.redirect=policy.authOrigin()+"/console/callback";this.clock=clock;
        transaction=new TransactionTemplate(manager);transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);transaction.setTimeout(10);
    }
    @Override public void run(ApplicationArguments ignored){initialize();}
    public void initialize(){transaction.executeWithoutResult(status->{
        var binding=registrations.lock();
        // MyBatis can map a row containing only NULL columns to null; the UPDATE anchor exists from V10.
        if(binding!=null&&binding.applicationId()!=null){
            var client=platforms.client(clientId);
            if(client==null||!client.id().equals(binding.loginClientId())||!client.applicationId().equals(binding.applicationId()))
                throw new IllegalStateException("Console registration conflicts with deployment configuration");
            return; // Never overwrite edits or re-enable a disabled application/client on restart.
        }
        if(platforms.client(clientId)!=null)throw new IllegalStateException("Console client ID is already registered; refusing adoption");
        String application=UUID.randomUUID().toString(),client=UUID.randomUUID().toString();
        platforms.createApplication(application,"Molis Auth Console");
        platforms.createClient(client,clientId,application,"WEB","account profile");platforms.addRedirect(client,redirect);
        if(registrations.bind(application,client)!=1)throw new IllegalStateException("Console bootstrap anchor is missing");
        platforms.audit(new PlatformMapper.Audit(UUID.randomUUID().toString(),"platform.console.initialize","SUCCESS",null,null,
                UUID.randomUUID().toString(),clock.instant().truncatedTo(ChronoUnit.MICROS),application,client,"deployment bootstrap; no administrator granted"));
    });}
    public View configuration(){return Objects.requireNonNull(transaction.execute(status->{
        var binding=registrations.binding();if(binding==null)return View.disabled();
        var app=platforms.application(binding.applicationId());var client=platforms.client(clientId);
        if(app==null||client==null||!client.id().equals(binding.loginClientId())||!client.applicationId().equals(app.id())
                ||!"ACTIVE".equals(app.status())||!"ACTIVE".equals(client.status())||!"WEB".equals(client.clientType())
                ||!Set.copyOf(Arrays.asList(client.allowedScopes().split(" "))).containsAll(Set.of("account","profile"))
                ||!platforms.redirects(client.id()).contains(redirect))return View.disabled();
        return new View(true,clientId,redirect);
    }));}
    public record View(boolean enabled,String clientId,String redirectUri){public static View disabled(){return new View(false,null,null);}}
}
