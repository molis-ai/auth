package ai.molis.auth.authorization;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice(assignableTypes=AuthorizationController.class)
public final class AuthorizationErrors {
    @ExceptionHandler(ai.molis.auth.verification.EphemeralFailure.class) ResponseEntity<?> limited(ai.molis.auth.verification.EphemeralFailure failure,HttpServletRequest request){
        boolean limited=failure.reason()==ai.molis.auth.verification.EphemeralFailure.Reason.RATE_LIMITED;
        return ResponseEntity.status(limited?429:503).header("Retry-After",Long.toString(limited?Math.max(1,failure.retryAfterSeconds()):1))
                .body(AuthorizationController.error(limited?"RATE_LIMITED":"AUTH_UNAVAILABLE",(String)request.getAttribute(AuthorizationBoundary.REQUEST_ID),(String)request.getAttribute(AuthorizationBoundary.DECISION_ID)));
    }
    @ExceptionHandler({DataAccessException.class,TransactionException.class}) ResponseEntity<?> unavailable(Exception ignored,HttpServletRequest request){return error(503,"AUTH_UNAVAILABLE",request);}
    @ExceptionHandler({IllegalArgumentException.class,HttpMessageNotReadableException.class,MethodArgumentNotValidException.class}) ResponseEntity<?> invalid(Exception ignored,HttpServletRequest request){return error(400,"INVALID_REQUEST",request);}
    @ExceptionHandler(Exception.class) ResponseEntity<?> unexpected(Exception ignored,HttpServletRequest request){return error(500,"INTERNAL_ERROR",request);}
    private ResponseEntity<?> error(int status,String code,HttpServletRequest request){return ResponseEntity.status(status).body(AuthorizationController.error(code,
            (String)request.getAttribute(AuthorizationBoundary.REQUEST_ID),(String)request.getAttribute(AuthorizationBoundary.DECISION_ID)));}
}
