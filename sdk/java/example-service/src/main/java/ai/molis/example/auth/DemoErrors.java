package ai.molis.example.auth;

import ai.molis.auth.client.AuthFailure;
import java.util.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice(assignableTypes=ProjectController.class)
public class DemoErrors {
    @ExceptionHandler(Exception.class) public ResponseEntity<?> error(Exception failure){
        int status;String code;var details=new LinkedHashMap<String,Object>();
        if(failure instanceof AuthFailure auth){status=switch(auth.kind()){case USER_UNAUTHENTICATED->401;case FORBIDDEN,DENIED->403;default->503;};
            code=status==401?"LOGIN_REQUIRED":status==403?"FORBIDDEN":"AUTH_UNAVAILABLE";
            if(auth.requestId()!=null)details.put("authRequestId",auth.requestId());if(auth.decisionId()!=null)details.put("authDecisionId",auth.decisionId());
        }else if(failure instanceof DemoFailure demo){status=demo.status();code=demo.getMessage();}
        else if(failure instanceof org.springframework.web.bind.MethodArgumentNotValidException||failure instanceof org.springframework.http.converter.HttpMessageNotReadableException){status=400;code="INVALID_REQUEST";}
        else {status=503;code="SERVICE_UNAVAILABLE";}
        details.put("error",Map.of("code",code));var response=ResponseEntity.status(status);if(status==401)response.header("WWW-Authenticate","Bearer");return response.body(details);
    }
}
