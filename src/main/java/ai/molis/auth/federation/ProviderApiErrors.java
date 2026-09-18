package ai.molis.auth.federation;

import ai.molis.auth.login.*;
import ai.molis.auth.verification.EphemeralFailure;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.util.Set;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DataAccessException;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice(assignableTypes={ProviderController.class,ProviderContinuationController.class})
@ConditionalOnProperty(name="auth.federation.enabled",havingValue="true")
public final class ProviderApiErrors {
    private final LoginClientPolicy policy;
    public ProviderApiErrors(LoginClientPolicy policy){this.policy=policy;}
    @ExceptionHandler(Exception.class) public void handle(Exception failure,HttpServletRequest request,HttpServletResponse response) throws IOException {
        respond(failure,request,response,policy);
    }
    static void respond(Exception failure,HttpServletRequest request,HttpServletResponse response,LoginClientPolicy policy) throws IOException {
        int status=500;String code="AUTH_INTERNAL_ERROR";long retry=0;
        if(failure instanceof LoginFailure error){status=error.status();code=error.getMessage();}
        else if(failure instanceof ExternalFailure error) {
            code=error.getMessage();
            status=Set.of("AUTH_UNAVAILABLE","PROVIDER_UNAVAILABLE","PROVIDER_CONFIGURATION_ERROR").contains(code)?503:400;
        } else if(failure instanceof EphemeralFailure error) {
            status=error.reason()==EphemeralFailure.Reason.RATE_LIMITED?429:error.reason()==EphemeralFailure.Reason.INVALID_PROOF?400:503;
            code=status==429?"RATE_LIMITED":status==400?"INVALID_PROOF":"AUTH_UNAVAILABLE";retry=error.retryAfterSeconds();
        } else if(failure instanceof DataAccessException || failure instanceof TransactionException){status=503;code="AUTH_UNAVAILABLE";}
        else if(failure instanceof HttpMessageNotReadableException || failure instanceof MissingRequestHeaderException || failure instanceof IllegalArgumentException){status=400;code="INVALID_REQUEST";}
        if(!code.matches("[A-Z_]{1,64}")){status=500;code="AUTH_INTERNAL_ERROR";}
        if(retry>0)response.setHeader("Retry-After",Long.toString(retry));
        if(ProviderHttpBoundary.callback(request)) {
            // Do not leave provider code/error/user parameters in the final browser URL or copy them into HTML.
            response.setStatus(303);response.setHeader("Location",policy.authOrigin()+"/login#provider-error="+code);return;
        }
        response.setStatus(status);response.setContentType("application/json");response.setCharacterEncoding("UTF-8");
        response.getWriter().write("{\"error\":{\"code\":\""+code+"\"},\"requestId\":\""+ProviderController.requestId(request)+"\"}");
    }
}
