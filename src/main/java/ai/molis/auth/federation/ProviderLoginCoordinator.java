package ai.molis.auth.federation;

import ai.molis.auth.login.*;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.verification.RedisRateLimiter;
import java.net.URI;
import java.util.*;

/** Internal orchestration only. HTTP must keep Started.browserBinding in a protected browser cookie. */
public final class ProviderLoginCoordinator {
    private final Map<IdentityProvider, ProviderCodeClient> providers;
    private final RedisProviderTransactions providerTransactions;
    private final RedisAuthTransactions authTransactions;
    private final LoginClientPolicy policy;
    private final RedisRateLimiter limiter;
    private final ExternalAccountService accounts;
    private final ProviderMailboxContinuation continuation;

    public ProviderLoginCoordinator(Collection<ProviderCodeClient> clients, RedisProviderTransactions providerTransactions,
            RedisAuthTransactions authTransactions, LoginClientPolicy policy, RedisRateLimiter limiter, ExternalAccountService accounts) {
        this(clients,providerTransactions,authTransactions,policy,limiter,accounts,null);
    }
    ProviderLoginCoordinator(Collection<ProviderCodeClient> clients,RedisProviderTransactions providerTransactions,
            RedisAuthTransactions authTransactions,LoginClientPolicy policy,RedisRateLimiter limiter,ExternalAccountService accounts,ProviderMailboxContinuation continuation) {
        this.continuation=continuation;
        var entries = new EnumMap<IdentityProvider, ProviderCodeClient>(IdentityProvider.class);
        var callbacks = new HashSet<URI>();
        Objects.requireNonNull(policy);
        for (var client : clients) {
            Objects.requireNonNull(client);
            if (!LoginClientPolicy.origin(client.registration().callback().toASCIIString()).equals(policy.authOrigin())
                    || !callbacks.add(client.registration().callback())) throw new IllegalArgumentException("Provider callbacks must be distinct Auth-origin URLs");
            if (entries.put(client.registration().provider(), client) != null) throw new IllegalArgumentException("Duplicate provider registration");
        }
        this.providers = Map.copyOf(entries); this.providerTransactions = Objects.requireNonNull(providerTransactions);
        this.authTransactions = Objects.requireNonNull(authTransactions); this.policy = Objects.requireNonNull(policy);
        this.limiter = Objects.requireNonNull(limiter); this.accounts = Objects.requireNonNull(accounts);
    }

    /** Product-owned login pages first hand off to an Auth-origin bridge; no product-origin binding cookie. */
    public Started begin(IdentityProvider provider, String transaction, String origin, String address) {
        return begin(provider,transaction,origin,address,null);
    }
    public Started bind(IdentityProvider provider,String transaction,String origin,String address,String access) {
        policy.requireAuthOrigin(origin);
        limiter.acquire(RedisRateLimiter.Bucket.LOGIN_IP,address);
        return begin(provider,transaction,origin,address,accounts.bindingTarget(access));
    }
    Started reauthenticate(IdentityProvider provider,String state,String browser,String tx,String origin,String address){
        policy.requireAuthOrigin(origin);limiter.acquire(RedisRateLimiter.Bucket.LOGIN_IP,address);
        var pending=continuation.requireLink(state,browser,tx);
        limiter.acquire(RedisRateLimiter.Bucket.LOGIN_EMAIL,pending.targetEmail());
        var client=requireProvider(provider);String binding=TokenSecrets.generate();
        var issued=providerTransactions.create(client.registration(),tx,pending.owner(),binding,null,new RedisProviderTransactions.Link(state,browser));
        return new Started(client.authorize(issued.state(),issued.pending().nonce(),issued.pending().verifier()),issued.state(),binding);
    }
    private Started begin(IdentityProvider provider,String transaction,String origin,String address,ExternalAccountService.BindingTarget target) {
        var client = requireProvider(provider);
        policy.requireAuthOrigin(origin);
        if(target==null)limiter.acquire(RedisRateLimiter.Bucket.LOGIN_IP, address);
        policy.validate(authTransactions.read(transaction).context(), origin);
        if(target!=null&&!authTransactions.read(transaction).context().clientId().equals(target.clientId()))
            throw new LoginFailure(403,"CLIENT_MISMATCH");
        var claim = authTransactions.claim(transaction);
        try {
            policy.validate(claim.context(), origin);
            String browserBinding = TokenSecrets.generate();
            var issued = target==null?providerTransactions.create(client.registration(), transaction, claim.owner(), browserBinding)
                    :providerTransactions.create(client.registration(),transaction,claim.owner(),browserBinding,target);
            URI url = client.authorize(issued.state(), issued.pending().nonce(), issued.pending().verifier());
            return new Started(url, issued.state(), browserBinding);
        } catch (RuntimeException failure) {
            finish(transaction, claim.owner());
            throw safe(failure);
        }
    }

    /** No state/code retry. The binding must come from the browser, never from provider callback parameters. */
    public Finished callback(IdentityProvider provider, String state, String browserBinding, String code, String error,
            String locale, String requestId) {
        var client = requireProvider(provider);
        var pending = providerTransactions.consume(state, client.registration(), browserBinding);
        try {
            var context = authTransactions.owned(pending.authTransaction(), pending.claimOwner());
            policy.validate(context, policy.authOrigin());
            if (requestId == null || !requestId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
                throw new ExternalFailure("PROVIDER_RESPONSE_INVALID");
            if ((code == null) == (error == null)) throw new ExternalFailure("PROVIDER_RESPONSE_INVALID");
            if (error != null) throw new ExternalFailure("access_denied".equals(error) ? "PROVIDER_CANCELLED" : "PROVIDER_AUTHORIZATION_FAILED");
            var identity = client.exchange(code, pending.nonce(), pending.verifier(), pending.startedAt());
            if(pending.link()!=null)return continuation.linkProvider(pending.link().state(),pending.link().browser(),pending.authTransaction(),identity,requestId);
            // Revalidate after provider network calls before database writes or Redis publication.
            policy.validate(authTransactions.owned(pending.authTransaction(), pending.claimOwner()), policy.authOrigin());
            if(pending.target()!=null&&!context.clientId().equals(pending.target().clientId()))throw new LoginFailure(403,"CLIENT_MISMATCH");
            java.util.function.Consumer<ExternalAccountService.Result> publish=authenticated -> authTransactions.authenticated(pending.authTransaction(), pending.claimOwner(), authenticated.authenticationId());
            var result = pending.target()==null?accounts.loginAndPublish(identity,locale,requestId,publish)
                    :accounts.bindAndPublish(identity,pending.target(),requestId,publish);
            if(continuation!=null&&(result.status()==ExternalAccountService.Status.ACCOUNT_LINK_REQUIRED
                    ||result.status()==ExternalAccountService.Status.MAILBOX_VERIFICATION_REQUIRED&&continuation.mailboxEnabled()))
                return continuation.begin(state,browserBinding,pending.authTransaction(),pending.claimOwner(),identity);
            if (result.status() != ExternalAccountService.Status.AUTHENTICATED)
                throw new ExternalFailure(result.status() == ExternalAccountService.Status.ACCOUNT_LINK_REQUIRED
                        ? "ACCOUNT_LINK_REQUIRED" : "MAILBOX_VERIFICATION_REQUIRED");
            return new Finished(policy.authOrigin() + "/complete#transaction=" + pending.authTransaction());
        } catch (RuntimeException failure) {
            finish(pending.authTransaction(), pending.claimOwner());
            throw safe(failure);
        }
    }

    private ProviderCodeClient requireProvider(IdentityProvider provider) {
        var client = provider == null ? null : providers.get(provider);
        if (client == null) throw new ExternalFailure("PROVIDER_NOT_ENABLED");
        return client;
    }
    private void finish(String transaction, String owner) {
        try { authTransactions.finish(transaction, owner); }
        catch (LoginFailure absentOrUnavailable) {
            // It may have expired, or publication may have succeeded before a lost reply/DB rollback.
            // Never reset to READY, extend its TTL, or republish a root to recover from uncertainty.
            if (absentOrUnavailable.status() != 400) throw new ExternalFailure("AUTH_UNAVAILABLE");
        }
    }
    private static RuntimeException safe(RuntimeException failure) {
        if (failure instanceof ExternalFailure || failure instanceof LoginFailure) return failure;
        return new ExternalFailure("AUTH_UNAVAILABLE");
    }
    public record Started(URI authorizationUrl, String state, String browserBinding) {
        @Override public String toString() { return "Started[REDACTED]"; }
    }
    public record Finished(String continueUrl,boolean continuing,String completedContinuation) {
        public Finished(String continueUrl){this(continueUrl,false,null);}
        public Finished(String continueUrl,boolean continuing){this(continueUrl,continuing,null);}
        @Override public String toString() { return "Finished[REDACTED]"; }
    }
}
