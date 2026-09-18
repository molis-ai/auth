package ai.molis.example.auth;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.*;
import java.util.*;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

final class DemoBoundary extends OncePerRequestFilter {
    static final String USER_TOKEN="demo.user-access";
    private final boolean local;
    private static final JsonMapper JSON=JsonMapper.builder(tools.jackson.core.json.JsonFactory.builder().enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
        .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    DemoBoundary(boolean local){this.local=local;}
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain)throws IOException,ServletException{
        response.setHeader("Cache-Control","no-store");response.setHeader("Referrer-Policy","no-referrer");response.setHeader("X-Content-Type-Options","nosniff");
        if(!request.isSecure()&&!(local&&Set.of("127.0.0.1","::1","0:0:0:0:0:0:0:1").contains(request.getRemoteAddr()))){error(response,400,"HTTPS_REQUIRED");return;}
        var values=Collections.list(request.getHeaders("Authorization"));if(values.size()!=1||!values.getFirst().matches("(?i:Bearer) [A-Za-z0-9_-]{43}")){error(response,401,"LOGIN_REQUIRED");return;}
        request.setAttribute(USER_TOKEN,values.getFirst().substring(7));
        // Deliberately no cross-origin browser integration in this minimal backend example.
        if(request.getHeader("Origin")!=null||"cross-site".equals(request.getHeader("Sec-Fetch-Site"))){error(response,403,"CROSS_ORIGIN_DISABLED");return;}
        boolean list=request.getRequestURI().equals("/demo/projects")&&request.getMethod().equals("GET");
        if(request.getQueryString()!=null&&(!list||!Set.of("cursor","limit").containsAll(request.getParameterMap().keySet())||request.getParameterMap().values().stream().anyMatch(v->v.length!=1))){error(response,400,"INVALID_REQUEST");return;}
        byte[] body=request.getInputStream().readNBytes(16385);if(body.length>16384){error(response,413,"REQUEST_TOO_LARGE");return;}
        if(request.getMethod().equals("PUT")){
            String content=request.getContentType();if(content==null||!content.split(";",2)[0].strip().equalsIgnoreCase("application/json")){error(response,400,"JSON_REQUIRED");return;}
            try{var node=JSON.readTree(body);if(node==null||!node.isObject()||!Set.of("name","version").equals(new HashSet<>(node.propertyNames()))||!node.path("name").isString()||!node.path("version").isIntegralNumber())throw new IllegalArgumentException();}
            catch(RuntimeException invalid){error(response,400,"INVALID_REQUEST");return;}
        }else if(body.length!=0){error(response,400,"INVALID_REQUEST");return;}
        chain.doFilter(new HttpServletRequestWrapper(request){@Override public ServletInputStream getInputStream(){var input=new ByteArrayInputStream(body);return new ServletInputStream(){
            public int read(){return input.read();}public int read(byte[] value,int offset,int length){return input.read(value,offset,length);}
            public boolean isFinished(){return input.available()==0;}public boolean isReady(){return true;}public void setReadListener(ReadListener listener){throw new IllegalStateException("Synchronous endpoint");}
        };}},response);
    }
    private static void error(HttpServletResponse response,int status,String code)throws IOException{response.setStatus(status);response.setContentType("application/json");if(status==401)response.setHeader("WWW-Authenticate","Bearer");response.getWriter().write("{\"error\":{\"code\":\""+code+"\"}}");}
}
