package ai.molis.auth.space;

import ai.molis.auth.login.LoginClientPolicy;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.util.*;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

final class SpaceBoundary extends OncePerRequestFilter {
    static final String REQUEST_ID="auth.space.requestId",BODY="auth.space.body";
    private final LoginClientPolicy policy;
    private static final JsonMapper JSON=JsonMapper.builder(tools.jackson.core.json.JsonFactory.builder()
            .enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
            .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    SpaceBoundary(LoginClientPolicy policy){this.policy=policy;}
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain)throws IOException,ServletException{
        String id=UUID.randomUUID().toString();request.setAttribute(REQUEST_ID,id);response.setHeader("X-Request-ID",id);
        response.setHeader("Cache-Control","no-store");response.setHeader("Pragma","no-cache");response.setHeader("Vary","Origin");
        response.setHeader("Referrer-Policy","no-referrer");response.setHeader("X-Content-Type-Options","nosniff");
        if(!request.isSecure()&&!(policy.localDevelopment()&&LoginClientPolicy.loopback(request.getRemoteAddr()))){error(response,400,"HTTPS_REQUIRED",id);return;}
        var origins=Collections.list(request.getHeaders("Origin"));
        try{
            if(origins.size()>1||(origins.isEmpty()&&"cross-site".equals(request.getHeader("Sec-Fetch-Site")))||(!origins.isEmpty()&&!policy.allowedCorsOrigin(origins.getFirst()))){error(response,403,"ORIGIN_NOT_ALLOWED",id);return;}
        }catch(org.springframework.dao.DataAccessException unavailable){error(response,503,"AUTH_UNAVAILABLE",id);return;}
        if(!origins.isEmpty()){response.setHeader("Access-Control-Allow-Origin",origins.getFirst());response.setHeader("Access-Control-Expose-Headers","X-Request-ID, Retry-After");}
        if("OPTIONS".equals(request.getMethod())){
            String method=request.getHeader("Access-Control-Request-Method"),headers=request.getHeader("Access-Control-Request-Headers");
            if(origins.isEmpty()||method==null||!Set.of("GET","POST","PUT").contains(method)){error(response,400,"INVALID_REQUEST",id);return;}
            if(headers!=null)for(String header:headers.toLowerCase(Locale.ROOT).split(","))if(!Set.of("authorization","content-type").contains(header.strip())){error(response,403,"ORIGIN_NOT_ALLOWED",id);return;}
            response.setHeader("Access-Control-Allow-Methods","GET, POST, PUT, OPTIONS");response.setHeader("Access-Control-Allow-Headers","Authorization, Content-Type");response.setStatus(204);return;
        }
        try{
            if("GET".equals(request.getMethod())){
                if(request.getInputStream().read()!=-1)throw new IllegalArgumentException();
                boolean teams=request.getRequestURI().equals("/api/v1/spaces/teams");
                boolean audit=request.getRequestURI().matches("/api/v1/spaces/[^/]+/(audit|invitations)");
                boolean members=request.getRequestURI().matches("/api/v1/spaces/[^/]+/members");
                boolean paginated=teams||request.getRequestURI().matches("/api/v1/(spaces|invitations|spaces/[^/]+/(members|invitations|audit))");
                if(request.getQueryString()!=null&&!paginated)throw new IllegalArgumentException();
                var parameters=request.getParameterMap();if(!(teams?Set.of("cursor","limit","q","status","order"):members?Set.of("cursor","limit","q","page","sort","order"):audit?Set.of("cursor","limit","page"):Set.of("cursor","limit")).containsAll(parameters.keySet())||parameters.values().stream().anyMatch(v->v.length!=1))throw new IllegalArgumentException();
            }else if(Set.of("POST","PUT").contains(request.getMethod())){
                if(request.getQueryString()!=null)throw new IllegalArgumentException();
                var type=MediaType.parseMediaType(request.getContentType()==null?"":request.getContentType());
                if(!"application".equals(type.getType())||!"json".equals(type.getSubtype())){error(response,400,"JSON_REQUIRED",id);return;}
                boolean profile=("POST".equals(request.getMethod())&&"/api/v1/spaces".equals(request.getRequestURI()))||("PUT".equals(request.getMethod())&&request.getRequestURI().matches("/api/v1/spaces/[0-9a-fA-F-]{36}"));
                int maximum=profile?190000:16384;
                byte[] body=request.getInputStream().readNBytes(maximum+1);if(body.length>maximum){error(response,413,"REQUEST_TOO_LARGE",id);return;}
                var tree=JSON.readTree(body);if(tree==null||!tree.isObject())throw new IllegalArgumentException();request.setAttribute(BODY,tree);
            }else throw new IllegalArgumentException();
        }catch(IllegalArgumentException|tools.jackson.core.JacksonException invalid){error(response,400,"INVALID_REQUEST",id);return;}
        chain.doFilter(request,response);
    }
    private static void error(HttpServletResponse response,int status,String code,String id)throws IOException{
        response.setStatus(status);response.setContentType("application/json");response.getWriter().write("{\"error\":{\"code\":\""+code+"\"},\"requestId\":\""+id+"\"}");
    }
}
