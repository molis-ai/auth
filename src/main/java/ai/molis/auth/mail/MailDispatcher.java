package ai.molis.auth.mail;

import java.util.UUID;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** At-least-once delivery; SMTP cannot participate in the MySQL transaction or honor our lease fence. */
public final class MailDispatcher {
    private static final int MAX_ATTEMPTS = 5;
    private static final int[] RETRY_SECONDS = {15, 60, 300, 900};
    private final MailOutboxMapper mapper;
    private final MailTemplates templates;
    private final MailTransport transport;
    private final TransactionTemplate writes;
    private final TransactionTemplate outsideTransaction;
    public MailDispatcher(MailOutboxMapper mapper, MailTemplates templates, MailTransport transport,
            PlatformTransactionManager transactions) {
        this.mapper = mapper; this.templates = templates; this.transport = transport;
        writes = new TransactionTemplate(transactions);
        writes.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        writes.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        writes.setTimeout(5);
        outsideTransaction = new TransactionTemplate(transactions);
        outsideTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_NOT_SUPPORTED);
    }
    public boolean dispatchNext() { return dispatch(null); }
    // Restricted row selection for targeted tests/authorized internal dispatch, not an HTTP endpoint.
    boolean dispatch(String id) {
        return Boolean.TRUE.equals(outsideTransaction.execute(status -> dispatchOutsideTransaction(id)));
    }
    private boolean dispatchOutsideTransaction(String id) {
        var claim = writes.execute(status -> {
            var row = mapper.lockNext(id);
            if (row == null) return null;
            if (row.expiresAt() != null && !row.expiresAt().isAfter(mapper.databaseNow())) {
                mapper.abandonLocked(row.id(), "EXPIRED"); return new Claim(row, null);
            }
            if (row.attempts() >= MAX_ATTEMPTS) {
                mapper.abandonLocked(row.id(), "ATTEMPTS_EXHAUSTED"); return new Claim(row, null);
            }
            String lease = UUID.randomUUID().toString();
            mapper.claim(row.id(), lease);
            return new Claim(row, lease);
        });
        if (claim == null) return false;
        if (claim.lease() == null) return true;
        MailTransport.Message message;
        try { message = templates.render(claim.row()); }
        catch (IllegalArgumentException invalid) {
            failed(claim, "INVALID_PAYLOAD", true); return true;
        }
        if (mapper.ownsLiveLease(claim.row().id(), claim.lease()) != 1) return true;
        try { transport.send(message); }
        catch (MailTransport.DeliveryFailed unavailable) {
            failed(claim, "DELIVERY_FAILED", claim.row().attempts() + 1 >= MAX_ATTEMPTS); return true;
        }
        // A stale worker cannot acknowledge a task already reclaimed by another worker.
        writes.executeWithoutResult(status -> mapper.sent(claim.row().id(), claim.lease()));
        return true;
    }
    private void failed(Claim claim, String code, boolean terminal) {
        int delay = terminal ? 0 : RETRY_SECONDS[claim.row().attempts()];
        writes.executeWithoutResult(status -> mapper.failed(claim.row().id(), claim.lease(), terminal ? "FAILED" : "PENDING", code, delay));
    }
    private record Claim(MailOutboxMapper.Row row, String lease) {}
}
