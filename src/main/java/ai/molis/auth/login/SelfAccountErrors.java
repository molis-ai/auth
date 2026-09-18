package ai.molis.auth.login;

import ai.molis.auth.session.SessionService;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice(assignableTypes=SelfAccountController.class)
public final class SelfAccountErrors {
    @ExceptionHandler(Exception.class) public ResponseEntity<?> error(Exception error,HttpServletRequest request) {
        int status; String code;
        if (error instanceof LoginFailure failure) { status=failure.status();code=failure.getMessage(); }
        else if (error instanceof SessionService.SessionRejectedException failure) {
            status=failure.reason()==SessionService.Reason.INVALID_SCOPE?403:401;
            code=status==403?"ACCOUNT_SCOPE_REQUIRED":"UNAUTHENTICATED";
        } else if (error instanceof DataAccessException || error instanceof TransactionException) { status=503;code="AUTH_UNAVAILABLE"; }
        else if (error instanceof HttpMessageNotReadableException || error instanceof org.springframework.web.method.annotation.MethodArgumentTypeMismatchException) { status=400;code="INVALID_REQUEST"; }
        else { status=500;code="AUTH_INTERNAL_ERROR"; }
        var response=ResponseEntity.status(status);
        if (status==401) response.header("WWW-Authenticate","Bearer error=\"invalid_token\"");
        if (code.equals("ACCOUNT_SCOPE_REQUIRED")) response.header("WWW-Authenticate","Bearer error=\"insufficient_scope\", scope=\"account\"");
        return response.body(Map.of("error",Map.of("code",code),"requestId",LoginController.requestId(request)));
    }
}
