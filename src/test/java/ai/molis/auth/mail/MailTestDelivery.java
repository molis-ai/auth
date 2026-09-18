package ai.molis.auth.mail;

/** Test-only targeted dispatch avoids unrelated retained outbox messages in a disposable database. */
public final class MailTestDelivery {
    private MailTestDelivery() {}
    public static boolean dispatch(MailDispatcher dispatcher, String id) { return dispatcher.dispatch(id); }
}
