package ai.molis.auth.platform;

import ai.molis.auth.login.LoginClientPolicy;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.net.URI;
import java.util.*;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

/** Auth-origin administration, explicit user bearer only; never accepts cross-product browser cookies. */
final class PlatformBoundary extends OncePerRequestFilter {
    static final String REQUEST_ID="auth.platform.requestId",BODY="auth.platform.body";
    private final String origin;
    private final boolean local;
    private static final JsonMapper JSON=JsonMapper.builder(tools.jackson.core.json.JsonFactory.builder()
            .enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
            .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    PlatformBoundary(String issuer){origin=LoginClientPolicy.origin(issuer);local=origin.startsWith("http://")&&LoginClientPolicy.loopback(URI.create(origin).getHost());}
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain)throws IOException,ServletException{
        String id=UUID.randomUUID().toString();request.setAttribute(REQUEST_ID,id);
        response.setHeader("X-Request-ID",id);response.setHeader("Cache-Control","no-store");response.setHeader("Pragma","no-cache");
        response.setHeader("Referrer-Policy","no-referrer");response.setHeader("X-Content-Type-Options","nosniff");
        if(!request.isSecure()&&!(local&&Set.of("127.0.0.1","::1","0:0:0:0:0:0:0:1").contains(request.getRemoteAddr()))){error(response,400,"HTTPS_REQUIRED",id);return;}
        var origins=Collections.list(request.getHeaders("Origin"));
        if(origins.size()>1||(!origins.isEmpty()&&!origin.equals(origins.getFirst()))||"cross-site".equals(request.getHeader("Sec-Fetch-Site"))){error(response,403,"AUTH_ORIGIN_REQUIRED",id);return;}
        try{
            if("GET".equals(request.getMethod())){
                if(request.getInputStream().read()!=-1)throw invalid();
                boolean paginated=request.getRequestURI().matches("/api/v1/platform/(applications|users|audit|mail|applications/[^/]+/(clients|services))");
                if(request.getQueryString()!=null&&!paginated)throw invalid();
                var parameters=request.getParameterMap();
                if(!Set.of("cursor","limit").containsAll(parameters.keySet())||parameters.values().stream().anyMatch(values->values.length!=1))throw invalid();
            }else if(Set.of("POST","PUT").contains(request.getMethod())){
                if(request.getQueryString()!=null)throw invalid();
                MediaType type=MediaType.parseMediaType(request.getContentType()==null?"":request.getContentType());
                if(!"application".equals(type.getType())||!"json".equals(type.getSubtype())){error(response,400,"JSON_REQUIRED",id);return;}
                byte[] body=request.getInputStream().readNBytes(16385);
                if(body.length>16384){error(response,413,"REQUEST_TOO_LARGE",id);return;}
                var tree=JSON.readTree(body);if(tree==null||!tree.isObject())throw invalid();
                request.setAttribute(BODY,tree);
            }else throw invalid();
        }catch(IllegalArgumentException|tools.jackson.core.JacksonException invalid){error(response,400,"INVALID_REQUEST",id);return;}
        chain.doFilter(request,response);
    }
    private static IllegalArgumentException invalid(){return new IllegalArgumentException();}
    private static void error(HttpServletResponse response,int status,String code,String id)throws IOException{
        response.setStatus(status);response.setContentType("application/json");response.getWriter().write("{\"error\":{\"code\":\""+code+"\"},\"requestId\":\""+id+"\"}");
    }
}
