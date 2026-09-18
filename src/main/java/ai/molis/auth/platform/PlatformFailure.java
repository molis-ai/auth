package ai.molis.auth.platform;

public final class PlatformFailure extends RuntimeException {
    private final int status;
    public PlatformFailure(int status,String code){super(code);this.status=status;}
    public int status(){return status;}
}
