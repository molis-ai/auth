package ai.molis.auth.starter;

import ai.molis.auth.client.*;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.*;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.*;

/** Does not install filters, expose endpoints or replace the application's security chain. */
@AutoConfiguration
@ConditionalOnProperty(prefix="molis.auth",name="enabled",havingValue="true",matchIfMissing=true)
@ConditionalOnMissingBean(AuthorizationClient.class)
@EnableConfigurationProperties(MolisAuthProperties.class)
public class MolisAuthAutoConfiguration {
    @Bean @ConditionalOnMissingBean AuthOptions molisAuthOptions(MolisAuthProperties p){
        return new AuthOptions(p.getIssuer(),p.isAllowLoopbackHttp(),p.getConnectTimeout(),p.getRequestTimeout());
    }
    @Bean @ConditionalOnMissingBean ServiceCredentials.Provider molisServiceCredentials(MolisAuthProperties p){
        var credentials=new ServiceCredentials(p.getClientId(),p.getClientSecret());return ()->credentials;
    }
    @Bean(destroyMethod="close") @ConditionalOnMissingBean(AuthTransport.class)
    JdkAuthTransport molisAuthTransport(AuthOptions options){return new JdkAuthTransport(options);}
    @Bean AuthorizationClient molisAuthorizationClient(AuthOptions options,ServiceCredentials.Provider credentials,AuthTransport transport){
        return new HttpAuthorizationClient(options,credentials,transport);
    }
}
