package ai.molis.auth.federation;

import ai.molis.auth.verification.RedisMailboxProofs;
import java.util.function.Consumer;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

/** Internal primitive, not an HTTP API. Caller must validate the claimed provider continuation and browser binding. */
@Service
@ConditionalOnProperty(name="auth.ephemeral.enabled",havingValue="true")
final class ExternalMailboxAccounts {
    private final RedisMailboxProofs proofs;
    private final ExternalAccountService accounts;
    ExternalMailboxAccounts(RedisMailboxProofs proofs,ExternalAccountService accounts) {
        this.proofs=proofs;this.accounts=accounts;
    }
    ExternalAccountService.Result register(ProviderTokenVerifier.VerifiedIdentity identity,String challenge,
            String continuationSecret,String locale,String requestId,Consumer<ExternalAccountService.Result> publisher) {
        var mailbox=proofs.consume(challenge,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,continuationSecret);
        // Redis consumption is final even if MySQL or publication fails. A retry needs a new proof.
        return accounts.registerWithMailboxAndPublish(identity,mailbox,locale,requestId,publisher);
    }
}
