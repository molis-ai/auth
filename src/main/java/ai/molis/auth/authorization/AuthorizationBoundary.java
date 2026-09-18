package ai.molis.auth.authorization;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.*;
import java.net.URI;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;

/** Backend-only JSON boundary. Both identities are explicit headers; no ambient-cookie authentication. */
final class AuthorizationBoundary extends OncePerRequestFilter {
    static final String REQUEST_ID="auth.authorization.requestId",DECISION_ID="auth.authorization.decisionId";
    private final boolean local;
    private static final tools.jackson.databind.json.JsonMapper JSON=tools.jackson.databind.json.JsonMapper.builder(
            tools.jackson.core.json.JsonFactory.builder().enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
            .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    AuthorizationBoundary(String issuer){var uri=URI.create(issuer);local="http".equals(uri.getScheme())&&Set.of("localhost","127.0.0.1","[::1]").contains(uri.getHost());}
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain)throws IOException,ServletException {
        String requestId=UUID.randomUUID().toString(),decisionId=UUID.randomUUID().toString();
        request.setAttribute(REQUEST_ID,requestId);request.setAttribute(DECISION_ID,decisionId);
        response.setHeader("X-Request-ID",requestId);response.setHeader("X-Decision-ID",decisionId);
        response.setHeader("Cache-Control","no-store");response.setHeader("Pragma","no-cache");
        response.setHeader("Referrer-Policy","no-referrer");response.setHeader("X-Content-Type-Options","nosniff");
        boolean loopback=Set.of("127.0.0.1","::1","0:0:0:0:0:0:0:1").contains(request.getRemoteAddr());
        if(!request.isSecure()&&!(local&&loopback)){error(response,400,"HTTPS_REQUIRED",requestId,decisionId);return;}
        if(request.getHeader("Origin")!=null||"cross-site".equals(request.getHeader("Sec-Fetch-Site"))){error(response,403,"BACKEND_ONLY",requestId,decisionId);return;}
        if(!"POST".equals(request.getMethod())||request.getQueryString()!=null){error(response,400,"INVALID_REQUEST",requestId,decisionId);return;}
        try{
            var type=MediaType.parseMediaType(request.getContentType()==null?"":request.getContentType());
            if(!"application".equals(type.getType())||!"json".equals(type.getSubtype()))throw new IllegalArgumentException();
        }catch(IllegalArgumentException invalid){error(response,400,"JSON_REQUIRED",requestId,decisionId);return;}
        byte[] body=request.getInputStream().readNBytes(16385);
        if(body.length>16384){error(response,413,"REQUEST_TOO_LARGE",requestId,decisionId);return;}
        try {
            var tree=JSON.readTree(body);
            Set<String> fields=switch(request.getRequestURI()){
                case "/api/v1/authorization/check" -> Set.of("spaceId","action","resourceType","resourceId");
                case "/api/v1/authorization/allowed-actions" -> Set.of("spaceId");
                case "/api/v1/authorization/spaces" -> Set.of("action","cursor","limit");
                case "/api/v1/authorization/activity" -> Set.of();
                default -> Set.of();
            };
            if(tree==null||!tree.isObject()||!fields.containsAll(tree.propertyNames()))throw new IllegalArgumentException();
        } catch(tools.jackson.core.JacksonException|IllegalArgumentException invalid){error(response,400,"INVALID_REQUEST",requestId,decisionId);return;}
        chain.doFilter(new JsonRequest(request,body),response);
    }
    private static void error(HttpServletResponse response,int status,String code,String request,String decision)throws IOException{
        response.setStatus(status);response.setContentType("application/json");
        response.getWriter().write("{\"error\":{\"code\":\""+code+"\"},\"requestId\":\""+request+"\",\"decisionId\":\""+decision+"\"}");
    }
    private static final class JsonRequest extends HttpServletRequestWrapper {
        private final byte[] body;
        JsonRequest(HttpServletRequest request,byte[] body){super(request);this.body=body;}
        @Override public int getContentLength(){return body.length;}
        @Override public long getContentLengthLong(){return body.length;}
        @Override public ServletInputStream getInputStream(){var input=new ByteArrayInputStream(body);return new ServletInputStream(){
            @Override public int read(){return input.read();}
            @Override public int read(byte[] value,int offset,int length){return input.read(value,offset,length);}
            @Override public boolean isFinished(){return input.available()==0;}
            @Override public boolean isReady(){return true;}
            @Override public void setReadListener(ReadListener listener){throw new IllegalStateException("Synchronous endpoint");}
        };}
        @Override public BufferedReader getReader(){return new BufferedReader(new InputStreamReader(getInputStream(),java.nio.charset.StandardCharsets.UTF_8));}
    }
}
