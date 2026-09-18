package ai.molis.example.auth;

final class DemoFailure extends RuntimeException {
    private final int status;
    DemoFailure(int status,String code){super(code);this.status=status;}
    int status(){return status;}
}
