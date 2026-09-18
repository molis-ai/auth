package ai.molis.auth;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.PlatformTransactionManager;
import ai.molis.auth.session.SessionMapper;
import ai.molis.auth.session.AuthorizationCodeMapper;
import ai.molis.auth.oauth.ClientRegistryMapper;
import static org.springframework.test.web.servlet.setup.MockMvcBuilders.webAppContextSetup;
import static org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers.springSecurity;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = "spring.autoconfigure.exclude=org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration")
class AuthApplicationTests {

	@Autowired WebApplicationContext context;
	@MockitoBean SessionMapper sessionMapper;
	@MockitoBean AuthorizationCodeMapper authorizationCodeMapper;
	@MockitoBean ClientRegistryMapper clientRegistryMapper;
	@MockitoBean ai.molis.auth.service.ServiceIdentityMapper serviceIdentityMapper;
	@MockitoBean ai.molis.auth.authorization.AuthorizationMapper authorizationMapper;
	@MockitoBean ai.molis.auth.persistence.AccountMapper accountMapper;
	@MockitoBean ai.molis.auth.account.AccountOperationMapper accountOperationMapper;
	@MockitoBean ai.molis.auth.account.AccountEventMapper accountEventMapper;
	@MockitoBean ai.molis.auth.federation.ExternalAccountMapper externalAccountMapper;
	@MockitoBean PlatformTransactionManager transactionManager;

	@Test
	void bootstrapOnlyExposesHealthAndNoPrototypeTokenEndpoint() throws Exception {
		var mvc = webAppContextSetup(context).apply(springSecurity()).build();
		mvc.perform(get("/actuator/health")).andExpect(status().isOk());
		mvc.perform(get("/api/v1/users/me")).andExpect(status().isUnauthorized());
		mvc.perform(get("/oauth2/token")).andExpect(status().isUnauthorized());
		mvc.perform(get("/actuator/env")).andExpect(status().isUnauthorized());
	}

	@Test
	void contextLoads() {
	}

}
