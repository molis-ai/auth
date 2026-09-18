package ai.molis.auth.starter;

import java.net.URI;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("molis.auth")
public class MolisAuthProperties {
    private URI issuer;
    private String clientId,clientSecret;
    private boolean allowLoopbackHttp;
    private Duration connectTimeout=Duration.ofSeconds(3),requestTimeout=Duration.ofSeconds(5);
    public URI getIssuer(){return issuer;} public void setIssuer(URI value){issuer=value;}
    public String getClientId(){return clientId;} public void setClientId(String value){clientId=value;}
    public String getClientSecret(){return clientSecret;} public void setClientSecret(String value){clientSecret=value;}
    public boolean isAllowLoopbackHttp(){return allowLoopbackHttp;} public void setAllowLoopbackHttp(boolean value){allowLoopbackHttp=value;}
    public Duration getConnectTimeout(){return connectTimeout;} public void setConnectTimeout(Duration value){connectTimeout=value;}
    public Duration getRequestTimeout(){return requestTimeout;} public void setRequestTimeout(Duration value){requestTimeout=value;}
    @Override public String toString(){return "MolisAuthProperties[credentials redacted]";}
}
