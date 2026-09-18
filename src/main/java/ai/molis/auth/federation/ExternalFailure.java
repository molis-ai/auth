package ai.molis.auth.federation;

/** Never retain raw provider responses, ID tokens, subjects or transport exceptions. */
public final class ExternalFailure extends RuntimeException {
    public ExternalFailure(String code) { super(code); }
    static ExternalFailure invalid() { return new ExternalFailure("PROVIDER_IDENTITY_INVALID"); }
    static ExternalFailure unavailable() { return new ExternalFailure("PROVIDER_UNAVAILABLE"); }
}
