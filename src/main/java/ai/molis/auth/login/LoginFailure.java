package ai.molis.auth.login;

public final class LoginFailure extends RuntimeException {
    private final int status;
    public LoginFailure(int status, String code) { super(code); this.status = status; }
    public int status() { return status; }
    public static LoginFailure invalid() { return new LoginFailure(400, "INVALID_TRANSACTION"); }
}
