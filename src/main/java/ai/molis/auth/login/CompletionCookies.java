package ai.molis.auth.login;

import ai.molis.auth.security.TokenSecrets;
import jakarta.servlet.http.*;
import java.util.*;
import org.springframework.http.ResponseCookie;

/** Per-transaction cookie: never the Auth login cookie, never returned as JSON. */
final class CompletionCookies {
    private CompletionCookies() {}
    static String name(HttpServletRequest request, String token) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) throw LoginFailure.invalid();
        return (request.isSecure() ? "__Host-auth_confirm_" : "auth_confirm_dev_") + TokenSecrets.digest(token);
    }
    static String read(HttpServletRequest request, String token, boolean starting) {
        String name = name(request, token); String value = null; int count = 0, size = 0;
        var headers = Collections.list(request.getHeaders("Cookie"));
        for (String header : headers) {
            size += header.length(); if (size > 8192) throw LoginFailure.invalid();
            for (String pair : header.split(";")) {
                var parts = pair.strip().split("=", 2);
                if (parts[0].startsWith("__Host-auth_confirm_") || parts[0].startsWith("auth_confirm_dev_")) count++;
                if (parts[0].equals(name)) {
                    if (value != null || parts.length != 2 || !parts[1].matches("[A-Za-z0-9_-]{43}")) throw LoginFailure.invalid();
                    value = parts[1];
                }
            }
        }
        if (starting && value == null && count >= 5) throw new LoginFailure(429, "CONFIRMATION_TOO_MANY_PENDING");
        return value;
    }
    static void write(HttpServletRequest request, HttpServletResponse response, String token, String value, long seconds) {
        response.addHeader("Set-Cookie", ResponseCookie.from(name(request, token), value).httpOnly(true).secure(request.isSecure())
                .sameSite("Strict").path("/").maxAge(seconds).build().toString());
    }
}
