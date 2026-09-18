package ai.molis.auth.federation;

import java.net.URI;
import java.util.Objects;

/** One Auth-owned web registration. Product callback/client IDs never replace these values. */
public record ProviderRegistration(IdentityProvider provider,String clientId,URI callback) {
    public ProviderRegistration {
        Objects.requireNonNull(provider);clientId(clientId);
        if(callback==null||!"https".equals(callback.getScheme())||callback.getHost()==null||callback.getRawUserInfo()!=null
                ||callback.getRawQuery()!=null||callback.getRawFragment()!=null||callback.getRawPath().isEmpty()
                ||!callback.normalize().equals(callback)) throw new IllegalArgumentException("Invalid provider callback");
        if(provider==IdentityProvider.APPLE&&(callback.getHost().equalsIgnoreCase("localhost")||callback.getHost().matches("[0-9.]+")||callback.getHost().contains(":")))
            throw new IllegalArgumentException("Apple web callback requires a domain");
    }
    static void clientId(String value){if(value==null||!value.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,254}"))throw new IllegalArgumentException("Invalid provider registration");}
}
