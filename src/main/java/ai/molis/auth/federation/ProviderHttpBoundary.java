package ai.molis.auth.federation;

import ai.molis.auth.login.*;
import ai.molis.auth.verification.*;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;

/** Narrow exception for fixed OAuth callbacks; never relax the first-party JSON boundary globally. */
public final class ProviderHttpBoundary extends OncePerRequestFilter {
    static final String PAYLOAD="auth.provider.callback";
    static final String COOKIE_PREFIX="__Host-auth_provider_";
    private final LoginClientPolicy policy;
    private final RedisRateLimiter limiter;
    private final AuthHttpBoundary firstParty;
    public ProviderHttpBoundary(LoginClientPolicy policy,RedisRateLimiter limiter) {
        this.policy=policy;this.limiter=limiter;this.firstParty=new AuthHttpBoundary(policy,false);
    }
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws IOException,ServletException {
        String requestId=UUID.randomUUID().toString();request.setAttribute(AuthHttpBoundary.REQUEST_ID,requestId);
        response.setHeader("X-Request-ID",requestId);response.setHeader("Cache-Control","no-store");response.setHeader("Pragma","no-cache");
        response.setHeader("Referrer-Policy","no-referrer");
        response.setHeader("Content-Security-Policy","default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        try {
            if(!request.isSecure())throw new LoginFailure(400,"HTTPS_REQUIRED");
            if(!callback(request)) {
                policy.requireAuthOrigin(request.getHeader("Origin"));
                if(Collections.list(request.getHeaders(AuthHttpBoundary.TRANSACTION_HEADER)).size()>1)throw new LoginFailure(400,"INVALID_REQUEST");
                long pending=rawCookies(request).keySet().stream().filter(name->name.startsWith(COOKIE_PREFIX)).count();
                if(pending>=5&&(!request.getRequestURI().startsWith("/api/v1/auth/providers/continuation/")||request.getRequestURI().endsWith("/reauthenticate")))throw new LoginFailure(429,"PROVIDER_TOO_MANY_PENDING");
                firstParty.doFilter(request,response,chain);return;
            }
            limiter.acquire(RedisRateLimiter.Bucket.PROVIDER_CALLBACK_IP,request.getRemoteAddr());
            IdentityProvider provider=switch(request.getRequestURI()) {
                case "/oauth2/callback/google" -> IdentityProvider.GOOGLE;
                case "/oauth2/callback/apple" -> IdentityProvider.APPLE;
                default -> throw new LoginFailure(400,"INVALID_REQUEST");
            };
            if(Collections.list(request.getHeaders("Origin")).size()>1)throw new LoginFailure(403,"ORIGIN_NOT_ALLOWED");
            String origin=request.getHeader("Origin");
            if(provider==IdentityProvider.APPLE) {
                if(!"POST".equals(request.getMethod()) || request.getQueryString()!=null)throw new LoginFailure(400,"INVALID_REQUEST");
                // A null Origin is not sufficient proof either way; state + protected browser cookie remains mandatory.
                if(origin!=null && !origin.equals("https://appleid.apple.com") && !origin.equals("null"))throw new LoginFailure(403,"ORIGIN_NOT_ALLOWED");
                try {
                    MediaType type=MediaType.parseMediaType(request.getContentType()==null?"":request.getContentType());
                    if(!type.getType().equals("application") || !type.getSubtype().equals("x-www-form-urlencoded")
                            || (type.getCharset()!=null && !type.getCharset().equals(StandardCharsets.UTF_8)))throw new LoginFailure(400,"FORM_REQUIRED");
                } catch(IllegalArgumentException invalid){throw new LoginFailure(400,"FORM_REQUIRED");}
            } else {
                if(!"GET".equals(request.getMethod()))throw new LoginFailure(400,"INVALID_REQUEST");
                if(origin!=null && !Set.of("https://accounts.google.com",policy.authOrigin(),"null").contains(origin))throw new LoginFailure(403,"ORIGIN_NOT_ALLOWED");
            }
            String encoded;
            if(provider==IdentityProvider.APPLE) {
                byte[] bytes=request.getInputStream().readNBytes(32769);
                if(bytes.length>32768)throw new LoginFailure(413,"REQUEST_TOO_LARGE");
                for(byte value:bytes)if(value<32 || value>126)throw new LoginFailure(400,"INVALID_REQUEST");
                encoded=new String(bytes,StandardCharsets.US_ASCII);
            } else {
                encoded=request.getQueryString();
                if(encoded!=null && encoded.length()>16384)throw new LoginFailure(413,"REQUEST_TOO_LARGE");
                if(request.getInputStream().read()!=-1)throw new LoginFailure(400,"INVALID_REQUEST");
            }
            var fields=parse(encoded,provider);
            String state=fields.get("state");
            if(state==null || !state.matches("[A-Za-z0-9_-]{43}"))throw new LoginFailure(400,"INVALID_REQUEST");
            String code=fields.get("code"),error=fields.get("error");
            if((code==null)==(error==null) || (code!=null && !code.matches("[!-~]{1,4096}"))
                    || (error!=null && !error.matches("[A-Za-z0-9_]{1,100}")))throw new LoginFailure(400,"INVALID_REQUEST");
            if(fields.containsKey("iss") && !fields.get("iss").equals(provider.issuer()))throw new LoginFailure(400,"INVALID_REQUEST");
            var cookies=rawCookies(request);String binding=cookies.get(cookieName(state));
            if(binding==null || !binding.matches("[A-Za-z0-9_-]{43}"))throw new ExternalFailure("PROVIDER_TRANSACTION_INVALID");
            request.setAttribute(PAYLOAD,new Callback(provider,state,binding,code,error));
            chain.doFilter(request,response);
        } catch(LoginFailure | ExternalFailure | EphemeralFailure failure) {
            ProviderApiErrors.respond(failure,request,response,policy);
        }
    }
    static boolean callback(HttpServletRequest request){return request.getRequestURI().startsWith("/oauth2/callback/");}
    static String cookieName(String state){return COOKIE_PREFIX+state;}
    static Map<String,String> rawCookies(HttpServletRequest request) {
        var cookies=new HashMap<String,String>();int size=0;
        for(String header:Collections.list(request.getHeaders("Cookie"))) {
            size+=header.length();if(size>8192)throw new LoginFailure(413,"REQUEST_TOO_LARGE");
            for(String part:header.split(";")) {
                var pair=part.strip().split("=",2);
                if(pair.length==2 && pair[0].startsWith(COOKIE_PREFIX) && cookies.put(pair[0],pair[1])!=null)throw new LoginFailure(400,"INVALID_REQUEST");
            }
        }
        return cookies;
    }
    static Map<String,String> parse(String form,IdentityProvider provider) {
        if(form==null || form.isEmpty())throw new LoginFailure(400,"INVALID_REQUEST");
        var allowed=provider==IdentityProvider.APPLE?Set.of("state","code","error","error_description","error_uri","user","id_token","iss")
                :Set.of("state","code","error","error_description","error_uri","scope","authuser","prompt","hd","iss");
        var fields=new HashMap<String,String>();
        for(String part:form.split("&",-1)) {
            var pair=part.split("=",2);if(pair.length!=2)throw new LoginFailure(400,"INVALID_REQUEST");
            String key=decode(pair[0]),value=decode(pair[1]);
            if(!allowed.contains(key) || fields.put(key,value)!=null || fields.size()>12)throw new LoginFailure(400,"INVALID_REQUEST");
            int max=key.equals("id_token")?16384:key.equals("code") || key.equals("user")?4096:1024;
            if(value.length()>max)throw new LoginFailure(413,"REQUEST_TOO_LARGE");
        }
        return fields;
    }
    private static String decode(String value) {
        var bytes=new ByteArrayOutputStream();
        try {
            for(int i=0;i<value.length();i++) {
                char c=value.charAt(i);
                if(c=='%') {
                    if(i+2>=value.length())throw new IllegalArgumentException();
                    int a=hex(value.charAt(++i)),b=hex(value.charAt(++i));
                    if(a<0||b<0)throw new IllegalArgumentException();bytes.write(a*16+b);
                } else {if(c<32||c>126)throw new IllegalArgumentException();bytes.write(c=='+'?32:c);}
            }
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        } catch(IllegalArgumentException | CharacterCodingException invalid){throw new LoginFailure(400,"INVALID_REQUEST");}
    }
    private static int hex(char value) {
        if(value>='0'&&value<='9')return value-'0';
        if(value>='a'&&value<='f')return value-'a'+10;
        if(value>='A'&&value<='F')return value-'A'+10;
        return -1;
    }
    record Callback(IdentityProvider provider,String state,String binding,String code,String error) {
        @Override public String toString(){return "ProviderCallback[REDACTED]";}
    }
}
