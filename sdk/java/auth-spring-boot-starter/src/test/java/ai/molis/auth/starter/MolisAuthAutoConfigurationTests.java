package ai.molis.auth.starter;

import ai.molis.auth.client.*;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class MolisAuthAutoConfigurationTests {
    ApplicationContextRunner runner=new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(MolisAuthAutoConfiguration.class));
    String[] properties={"molis.auth.issuer=https://auth.example.test","molis.auth.client-id=svc_00000000-0000-0000-0000-000000000001","molis.auth.client-secret="+"s".repeat(43)};
    @Test void validConfigurationCreatesClientWithoutNetworkOrSecurityFilters(){runner.withPropertyValues(properties).run(context->{assertThat(context).hasSingleBean(AuthorizationClient.class).hasSingleBean(JdkAuthTransport.class);assertThat(context.getBeanDefinitionNames()).noneMatch(name->name.contains("securityFilter"));});}
    @Test void missingConfigurationFailsClosed(){runner.run(context->assertThat(context).hasFailed());}
    @Test void disabledConfigurationDoesNotCreatePermissiveClient(){runner.withPropertyValues("molis.auth.enabled=false").run(context->assertThat(context).doesNotHaveBean(AuthorizationClient.class));}
    @Test void userClientReplacementBacksOffAllDefaultConfiguration(){var custom=mock(AuthorizationClient.class);runner.withBean(AuthorizationClient.class,()->custom).run(context->{assertThat(context).hasSingleBean(AuthorizationClient.class).doesNotHaveBean(AuthTransport.class);assertThat(context.getBean(AuthorizationClient.class)).isSameAs(custom);});}
    @Test void externalCredentialAndMtlsTransportProvidersCanBeReplaced(){var credentials=mock(ServiceCredentials.Provider.class);var transport=mock(AuthTransport.class);
        runner.withPropertyValues("molis.auth.issuer=https://auth.example.test").withBean(ServiceCredentials.Provider.class,()->credentials).withBean(AuthTransport.class,()->transport)
            .run(context->{assertThat(context).hasSingleBean(AuthorizationClient.class).doesNotHaveBean(JdkAuthTransport.class);verifyNoInteractions(credentials,transport);});}
    @Test void loopbackHttpIsExplicitOptInAndPropertiesDoNotPrintSecret(){runner.withPropertyValues(properties).withPropertyValues("molis.auth.issuer=http://127.0.0.1:41880").run(context->assertThat(context).hasFailed());
        runner.withPropertyValues(properties).withPropertyValues("molis.auth.issuer=http://127.0.0.1:41880","molis.auth.allow-loopback-http=true").run(context->{assertThat(context).hasSingleBean(AuthorizationClient.class);assertThat(context.getBean(MolisAuthProperties.class).toString()).doesNotContain("s".repeat(43));});}
}
