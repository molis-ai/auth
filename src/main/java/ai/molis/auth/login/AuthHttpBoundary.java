package ai.molis.auth.login;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;

/** Cookie-bearing restore/complete still require a same-Auth-origin transaction header in the coordinator. */
public final class AuthHttpBoundary extends OncePerRequestFilter {
    public static final String REQUEST_ID = "auth.requestId";
    public static final String TRANSACTION_HEADER = "X-Auth-Transaction";
    private final LoginClientPolicy policy;
    private final boolean oauth;
    public AuthHttpBoundary(LoginClientPolicy policy, boolean oauth) { this.policy = policy; this.oauth = oauth; }
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String requestId = request.getAttribute(REQUEST_ID) instanceof String assigned ? assigned : UUID.randomUUID().toString(); request.setAttribute(REQUEST_ID, requestId);
        response.setHeader("X-Request-ID", requestId); response.setHeader("Cache-Control", "no-store");
        response.setHeader("Pragma", "no-cache"); response.setHeader("Vary", "Origin");
        try {
            if (!request.isSecure() && !(policy.localDevelopment() && LoginClientPolicy.loopback(request.getRemoteAddr())))
                throw new LoginFailure(400, "HTTPS_REQUIRED");
            String origin = request.getHeader("Origin");
            if (java.util.Collections.list(request.getHeaders("Origin")).size()>1) throw new LoginFailure(403,"ORIGIN_NOT_ALLOWED");
            // Public pages can load cross-site; completion now requires an explicit account
            // confirmation plus an Auth-origin response proof and browser-bound HttpOnly cookie.
            boolean publicNavigation = !oauth && publicNavigation(request);
            if (!publicNavigation && origin == null && "cross-site".equals(request.getHeader("Sec-Fetch-Site")))
                throw new LoginFailure(403, "ORIGIN_NOT_ALLOWED");
            if (!publicNavigation && origin != null) {
                if (!policy.allowedCorsOrigin(origin)) throw new LoginFailure(403, "ORIGIN_NOT_ALLOWED");
                response.setHeader("Access-Control-Allow-Origin", origin);
                response.setHeader("Access-Control-Expose-Headers", "X-Request-ID, Retry-After");
            }
            if (request.getMethod().equals("OPTIONS")) {
                String headers = request.getHeader("Access-Control-Request-Headers");
                if (headers != null) for (String header : headers.toLowerCase(Locale.ROOT).split(","))
                    if (!Set.of("content-type", "x-auth-transaction", "authorization").contains(header.strip())) throw new LoginFailure(403, "ORIGIN_NOT_ALLOWED");
                String method = request.getHeader("Access-Control-Request-Method");
                if (origin == null || method == null || !Set.of("POST", "GET").contains(method)) throw new LoginFailure(400, "INVALID_REQUEST");
                response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Auth-Transaction, Authorization");
                response.setStatus(204); return;
            }
            if (!oauth) {
                // This public HTML route receives OAuth response parameters; the SDK consumes and clears them.
                boolean consoleCallback="GET".equals(request.getMethod())&&"/console/callback".equals(request.getRequestURI());
                boolean selfPage="GET".equals(request.getMethod())&&Set.of("/api/v1/sessions/authentications","/api/v1/sessions/security-events").contains(request.getRequestURI());
                if (selfPage) {
                    if(request.getQueryString()!=null&&request.getQueryString().length()>256) throw new LoginFailure(400,"INVALID_REQUEST");
                    for(var entry:request.getParameterMap().entrySet())
                        if(!Set.of("limit","cursor").contains(entry.getKey())||entry.getValue().length!=1||entry.getValue()[0].isEmpty()) throw new LoginFailure(400,"INVALID_REQUEST");
                    if(request.getInputStream().read()!=-1) throw new LoginFailure(400,"INVALID_REQUEST");
                }
                if (request.getQueryString() != null && !consoleCallback && !selfPage) throw new LoginFailure(400, "INVALID_REQUEST");
                if (request.getMethod().equals("POST")) {
                    MediaType type;
                    try { type = MediaType.parseMediaType(request.getContentType() == null ? "" : request.getContentType()); }
                    catch (IllegalArgumentException invalid) { throw new LoginFailure(400, "JSON_REQUIRED"); }
                    if (!"application".equals(type.getType()) || !"json".equals(type.getSubtype())) throw new LoginFailure(400, "JSON_REQUIRED");
                    int maxBody = "/api/v1/users/me/profile".equals(request.getRequestURI()) ? 190000 : 16384;
                    byte[] body = request.getInputStream().readNBytes(maxBody + 1);
                    if (body.length > maxBody) throw new LoginFailure(413, "REQUEST_TOO_LARGE");
                    request = new JsonRequest(request, body);
                }
            }
            chain.doFilter(request, response);
        } catch (LoginFailure failure) { error(response, failure.status(), failure.getMessage(), requestId); }
        catch (DataAccessException unavailable) { error(response, 503, "AUTH_UNAVAILABLE", requestId); }
    }
    private static boolean publicNavigation(HttpServletRequest request) {
        return "GET".equals(request.getMethod()) && "navigate".equals(request.getHeader("Sec-Fetch-Mode"))
                && "document".equals(request.getHeader("Sec-Fetch-Dest"))
                && Set.of("/", "/login", "/provider", "/provider-mailbox", "/register", "/forgot-password", "/complete",
                        "/verify-email", "/console", "/console/callback").contains(request.getRequestURI());
    }
    private void error(HttpServletResponse response, int status, String code, String requestId) throws IOException {
        response.setStatus(status); response.setContentType("application/json"); response.setCharacterEncoding("UTF-8");
        if (oauth) response.getWriter().write(status == 503 ? "{\"error\":\"temporarily_unavailable\"}" : "{\"error\":\"invalid_request\"}");
        else response.getWriter().write("{\"error\":{\"code\":\"" + code + "\"},\"requestId\":\"" + requestId + "\"}");
    }
    private static final class JsonRequest extends HttpServletRequestWrapper {
        private final byte[] body;
        JsonRequest(HttpServletRequest request, byte[] body) { super(request); this.body = body; }
        @Override public int getContentLength() { return body.length; }
        @Override public long getContentLengthLong() { return body.length; }
        @Override public ServletInputStream getInputStream() {
            var input = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override public int read() { return input.read(); }
                @Override public int read(byte[] bytes, int offset, int length) { return input.read(bytes, offset, length); }
                @Override public boolean isFinished() { return input.available() == 0; }
                @Override public boolean isReady() { return true; }
                @Override public void setReadListener(ReadListener listener) { throw new IllegalStateException("Synchronous JSON endpoint"); }
            };
        }
        @Override public BufferedReader getReader() { return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8)); }
    }
}
