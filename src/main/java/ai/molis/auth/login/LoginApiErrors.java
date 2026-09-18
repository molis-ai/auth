package ai.molis.auth.login;

import ai.molis.auth.session.SessionService;
import ai.molis.auth.verification.EphemeralFailure;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice(assignableTypes = {LoginController.class, MailboxAccountController.class})
@ConditionalOnProperty(name = "auth.login.enabled", havingValue = "true")
public final class LoginApiErrors {
    @ExceptionHandler(Exception.class)
    public ResponseEntity<?> error(Exception error, HttpServletRequest request) {
        int status; String code; long retry = 0;
        if (error instanceof LoginFailure failure) { status = failure.status(); code = failure.getMessage(); }
        else if (error instanceof ai.molis.auth.account.PasswordHashing.PasswordRejectedException failure) {
            status = 400; code = failure.getMessage();
        }
        else if (error instanceof EphemeralFailure failure) {
            status = failure.reason() == EphemeralFailure.Reason.RATE_LIMITED ? 429 : failure.reason() == EphemeralFailure.Reason.UNAVAILABLE ? 503 : 400;
            code = status == 429 ? "RATE_LIMITED" : status == 503 ? "AUTH_UNAVAILABLE" : "INVALID_TRANSACTION";
            retry = failure.retryAfterSeconds();
        } else if (error instanceof DataAccessException || error instanceof TransactionException) { status = 503; code = "AUTH_UNAVAILABLE"; }
        else if (error instanceof SessionService.SessionRejectedException) { status = 400; code = "INVALID_TRANSACTION"; }
        else if (error instanceof MethodArgumentNotValidException || error instanceof HttpMessageNotReadableException
                || error instanceof MissingRequestHeaderException || error instanceof IllegalArgumentException) { status = 400; code = "INVALID_REQUEST"; }
        else { status = 500; code = "AUTH_INTERNAL_ERROR"; }
        var builder = ResponseEntity.status(status);
        if (retry > 0) builder.header("Retry-After", Long.toString(retry));
        return builder.body(Map.of("error", Map.of("code", code), "requestId", LoginController.requestId(request)));
    }
}
