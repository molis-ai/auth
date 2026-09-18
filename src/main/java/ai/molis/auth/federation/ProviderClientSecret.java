package ai.molis.auth.federation;

/** Server-only secret source, queried per exchange so deployment rotation need not retain old credentials. */
@FunctionalInterface
public interface ProviderClientSecret {
    String current(String clientId);
}
