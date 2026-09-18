package ai.molis.auth.platform;

import ai.molis.auth.service.ServiceIdentityService;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.dao.*;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice(assignableTypes=PlatformController.class)
public final class PlatformErrors {
    @ExceptionHandler(Exception.class) public ResponseEntity<?> error(Exception failure,HttpServletRequest request){
        int status;String code;
        if(failure instanceof PlatformFailure rejected){status=rejected.status();code=rejected.getMessage();}
        else if(failure instanceof DuplicateKeyException){status=409;code="ALREADY_EXISTS";}
        else if(failure instanceof DataAccessException||failure instanceof TransactionException){status=503;code="AUTH_UNAVAILABLE";}
        else if(failure instanceof ServiceIdentityService.Rejected){status=409;code="SERVICE_NOT_ACTIVE";}
        else if(failure instanceof IllegalArgumentException){status=400;code="INVALID_REQUEST";}
        else{status=500;code="INTERNAL_ERROR";}
        var response=ResponseEntity.status(status);
        if(status==401)response.header("WWW-Authenticate","Bearer error=\"invalid_token\"");
        if(code.equals("ACCOUNT_SCOPE_REQUIRED"))response.header("WWW-Authenticate","Bearer error=\"insufficient_scope\", scope=\"account\"");
        return response.body(Map.of("error",Map.of("code",code),"requestId",request.getAttribute(PlatformBoundary.REQUEST_ID)));
    }
}
