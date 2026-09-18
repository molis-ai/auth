package ai.molis.auth.client;

/** Safe, bounded error metadata. Never attaches an HTTP body, request, credential or underlying exception. */
public final class AuthFailure extends RuntimeException {
    public enum Kind { INVALID_INPUT, USER_UNAUTHENTICATED, SERVICE_UNAUTHENTICATED, FORBIDDEN, DENIED, UNAVAILABLE, INVALID_RESPONSE, INTERRUPTED, SCOPE_TOO_LARGE }
    private final Kind kind;
    private final String requestId, decisionId;
    public AuthFailure(Kind kind) { this(kind, null, null); }
    public AuthFailure(Kind kind, String requestId, String decisionId) {
        super(kind.name()); this.kind=kind; this.requestId=safeId(requestId); this.decisionId=safeId(decisionId);
    }
    public Kind kind() { return kind; }
    public String requestId() { return requestId; }
    public String decisionId() { return decisionId; }
    private static String safeId(String value) { return value!=null&&value.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")?value:null; }
}
