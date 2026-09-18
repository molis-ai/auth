package ai.molis.auth.space;

import ai.molis.auth.verification.EphemeralFailure;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice(assignableTypes=SpaceController.class)
public final class SpaceErrors {
    @ExceptionHandler(Exception.class) public ResponseEntity<?> error(Exception error,HttpServletRequest request){
        int status;String code;long retry=0;
        if(error instanceof SpaceFailure failure){status=failure.status();code=failure.getMessage();}
        else if(error instanceof EphemeralFailure failure){status=failure.reason()==EphemeralFailure.Reason.RATE_LIMITED?429:503;code=status==429?"RATE_LIMITED":"AUTH_UNAVAILABLE";retry=failure.retryAfterSeconds();}
        else if(error instanceof DataAccessException||error instanceof TransactionException){status=503;code="AUTH_UNAVAILABLE";}
        else if(error instanceof IllegalArgumentException){status=400;code="INVALID_REQUEST";}
        else{status=500;code="INTERNAL_ERROR";}
        var response=ResponseEntity.status(status);if(status==401)response.header("WWW-Authenticate","Bearer error=\"invalid_token\"");
        if(code.equals("ACCOUNT_SCOPE_REQUIRED"))response.header("WWW-Authenticate","Bearer error=\"insufficient_scope\", scope=\"account\"");
        if(status==429)response.header("Retry-After",Long.toString(Math.max(1,retry)));
        return response.body(Map.of("error",Map.of("code",code),"requestId",request.getAttribute(SpaceBoundary.REQUEST_ID)));
    }
}
