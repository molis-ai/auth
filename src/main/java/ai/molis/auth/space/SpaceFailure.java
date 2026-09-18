package ai.molis.auth.space;
public final class SpaceFailure extends RuntimeException {
    private final int status;
    public SpaceFailure(int status,String code){super(code);this.status=status;}
    public int status(){return status;}
}
