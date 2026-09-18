package ai.molis.auth.verification;

/** Stable safe failure categories; never expose Redis commands or secret arguments. */
public final class EphemeralFailure extends RuntimeException {
    public enum Reason { INVALID_PROOF, UNAVAILABLE, RATE_LIMITED }
    private final Reason reason;
    private final long retryAfterSeconds;
    public EphemeralFailure(Reason reason) { this(reason, 0); }
    public EphemeralFailure(Reason reason, long retryAfterSeconds) {
        super(reason.name()); this.reason = reason; this.retryAfterSeconds = retryAfterSeconds;
    }
    public Reason reason() { return reason; }
    public long retryAfterSeconds() { return retryAfterSeconds; }
}
