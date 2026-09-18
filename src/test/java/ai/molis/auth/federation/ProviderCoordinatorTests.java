package ai.molis.auth.federation;

import ai.molis.auth.login.*;
import ai.molis.auth.verification.RedisRateLimiter;
import java.net.URI;
import java.util.List;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class ProviderCoordinatorTests {
    @Test void registrationsMustHaveDistinctCallbacksOnAuthOriginAndOneEntryPerProvider() {
        var policy=mock(LoginClientPolicy.class);when(policy.authOrigin()).thenReturn("https://auth.example.test");
        var wrong=client(IdentityProvider.GOOGLE,"https://product.example.test/callback");
        var google=client(IdentityProvider.GOOGLE,"https://auth.example.test/callback");
        var apple=client(IdentityProvider.APPLE,"https://auth.example.test/callback");
        for(var clients:List.of(List.of(wrong),List.of(google,apple),List.of(google,google)))
            assertThatThrownBy(()->new ProviderLoginCoordinator(clients,mock(RedisProviderTransactions.class),mock(RedisAuthTransactions.class),policy,mock(RedisRateLimiter.class),mock(ExternalAccountService.class)))
                    .isInstanceOf(IllegalArgumentException.class).hasNoCause();
        verify(wrong,never()).authorize(anyString(),anyString(),anyString());
    }
    private ProviderCodeClient client(IdentityProvider provider,String callback) {
        var client=mock(ProviderCodeClient.class);
        when(client.registration()).thenReturn(new ProviderRegistration(provider,"test-client",URI.create(callback)));
        return client;
    }
}
