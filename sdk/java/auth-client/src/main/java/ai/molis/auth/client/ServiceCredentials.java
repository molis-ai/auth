package ai.molis.auth.client;

/** Backend-only credentials. A provider can read the latest external configuration on each token acquisition. */
public record ServiceCredentials(String clientId, String secret) {
    public ServiceCredentials {
        if(clientId==null||!clientId.matches("svc_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
                ||secret==null||!secret.matches("[A-Za-z0-9_-]{43}"))throw new AuthFailure(AuthFailure.Kind.INVALID_INPUT);
    }
    @Override public String toString() { return "ServiceCredentials[redacted]"; }
    @FunctionalInterface public interface Provider { ServiceCredentials current(); }
}
