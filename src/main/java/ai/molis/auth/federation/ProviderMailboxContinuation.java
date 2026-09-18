package ai.molis.auth.federation;

import ai.molis.auth.login.*;
import ai.molis.auth.mail.MailboxMailService;
import ai.molis.auth.verification.*;
import java.util.Map;

/** The original Auth claim remains BUSY until successful publication or explicit/terminal cancellation. */
final class ProviderMailboxContinuation {
    private final ProviderContinuations states;private final RedisAuthTransactions auth;private final LoginClientPolicy policy;
    private final MailboxMailService mail;private final RedisMailboxProofs proofs;private final ExternalAccountService accounts;private final RedisRateLimiter limiter;
    ProviderMailboxContinuation(ProviderContinuations states,RedisAuthTransactions auth,LoginClientPolicy policy,MailboxMailService mail,
            RedisMailboxProofs proofs,ExternalAccountService accounts,RedisRateLimiter limiter){this.states=states;this.auth=auth;this.policy=policy;this.mail=mail;this.proofs=proofs;this.accounts=accounts;this.limiter=limiter;}
    ProviderLoginCoordinator.Finished begin(String state,String browser,String tx,String owner,ProviderTokenVerifier.VerifiedIdentity identity) {
        policy.validate(auth.owned(tx,owner),policy.authOrigin());states.create(state,browser,tx,owner,identity);
        return new ProviderLoginCoordinator.Finished(policy.authOrigin()+"/provider-mailbox#transaction="+tx+"&continuation="+state,true);
    }
    private ProviderContinuations.Pending require(String state,String browser,String tx) {
        var pending=states.read(state,browser,tx);policy.validate(auth.owned(tx,pending.owner()),policy.authOrigin());return pending;
    }
    boolean mailboxEnabled(){return mail!=null;}
    Object context(String state,String browser,String tx) {
        var pending=require(state,browser,tx);
        boolean link=pending.targetEmail()!=null;
        return Map.of("context",auth.owned(tx,pending.owner()),"provider",pending.identity().provider().name().toLowerCase(java.util.Locale.ROOT),"expiresAt",pending.identity().expiresAt().toString(),
                "mode",link?"LINK_PASSWORD":"MAILBOX","email",link?pending.targetEmail():"");
    }
    Object request(String state,String browser,String tx,String email,String locale,String address,String requestId) {
        var pending=require(state,browser,tx);
        if(mail==null||pending.targetEmail()!=null)throw new LoginFailure(400,"INVALID_REQUEST");
        return mail.request(email,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,state,locale,address,requestId);
    }
    String complete(String state,String browser,String tx,String challenge,String locale,String address,String requestId) {
        if(require(state,browser,tx).targetEmail()!=null)throw new LoginFailure(400,"INVALID_REQUEST");
        limiter.acquire(RedisRateLimiter.Bucket.ACCOUNT_IP,address);
        // Clicking before verification must not destroy the provider continuation. An invalid proof does not consume it.
        var mailbox=proofs.consume(challenge,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,state);
        var pending=states.consume(state,browser,tx);
        try {
            if(pending.targetEmail()!=null)throw new LoginFailure(400,"INVALID_REQUEST");
            policy.validate(auth.owned(tx,pending.owner()),policy.authOrigin());
            var result=accounts.registerWithMailboxAndPublish(pending.identity(),mailbox,locale,requestId,
                    registered->auth.authenticated(tx,pending.owner(),registered.authenticationId()));
            if(result.status()==ExternalAccountService.Status.ACCOUNT_LINK_REQUIRED){
                // A deliberate new phase, not a retry: mailbox proof is durably consumed, identity deadline unchanged.
                policy.validate(auth.owned(tx,pending.owner()),policy.authOrigin());
                states.create(state,browser,tx,pending.owner(),pending.identity(),mailbox.email());
                return null;
            }
            return policy.authOrigin()+"/complete#transaction="+tx;
        } catch(RuntimeException failure){finish(tx,pending.owner());throw failure;}
    }
    void cancel(String state,String browser,String tx){require(state,browser,tx);var pending=states.consume(state,browser,tx);finish(tx,pending.owner());}
    String linkPassword(String state,String browser,String tx,String password,String address,String requestId) {
        var pending=require(state,browser,tx);
        if(pending.targetEmail()==null)throw new LoginFailure(400,"INVALID_REQUEST");
        limiter.acquire(RedisRateLimiter.Bucket.LOGIN_IP,address);
        limiter.acquire(RedisRateLimiter.Bucket.LOGIN_EMAIL,pending.targetEmail());
        try {
            accounts.linkWithPasswordAndPublish(pending.identity(),pending.targetEmail(),password,requestId,authenticated->{
                var consumed=states.consume(state,browser,tx);
                if(!consumed.owner().equals(pending.owner())||!consumed.identity().verificationId().equals(pending.identity().verificationId()))throw LoginFailure.invalid();
                policy.validate(auth.owned(tx,pending.owner()),policy.authOrigin());
                auth.authenticated(tx,pending.owner(),authenticated.authenticationId());
            });
            return policy.authOrigin()+"/complete#transaction="+tx;
        }catch(LoginFailure denied){if(!"INVALID_CREDENTIALS".equals(denied.getMessage()))finish(tx,pending.owner());throw denied;}
        catch(RuntimeException failure){finish(tx,pending.owner());throw failure;}
    }
    ProviderContinuations.Pending requireLink(String state,String browser,String tx){var pending=require(state,browser,tx);if(pending.targetEmail()==null)throw new LoginFailure(400,"INVALID_REQUEST");return pending;}
    ProviderLoginCoordinator.Finished linkProvider(String state,String browser,String tx,ProviderTokenVerifier.VerifiedIdentity verified,String requestId){
        var pending=requireLink(state,browser,tx);
        accounts.linkWithProviderAndPublish(pending.identity(),verified,pending.targetEmail(),requestId,authenticated->{
            var consumed=states.consume(state,browser,tx);
            if(!consumed.owner().equals(pending.owner())||!consumed.identity().verificationId().equals(pending.identity().verificationId()))throw LoginFailure.invalid();
            policy.validate(auth.owned(tx,pending.owner()),policy.authOrigin());
            auth.authenticated(tx,pending.owner(),authenticated.authenticationId());
        });
        return new ProviderLoginCoordinator.Finished(policy.authOrigin()+"/complete#transaction="+tx,false,state);
    }
    private void finish(String tx,String owner){try{auth.finish(tx,owner);}catch(LoginFailure failure){if(failure.status()!=400)throw failure;}}
}
