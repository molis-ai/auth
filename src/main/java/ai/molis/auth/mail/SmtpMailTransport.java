package ai.molis.auth.mail;

import ai.molis.auth.account.EmailAddress;
import jakarta.mail.MessagingException;
import jakarta.mail.internet.InternetAddress;
import org.springframework.mail.MailException;
import org.springframework.mail.javamail.JavaMailSender;

public final class SmtpMailTransport implements MailTransport {
    private final JavaMailSender sender;
    private final String from;
    public SmtpMailTransport(JavaMailSender sender, String from) {
        this.sender = sender; this.from = EmailAddress.canonicalize(from);
    }
    @Override public void send(MailTransport.Message message) {
        try {
            var mime = sender.createMimeMessage();
            mime.setFrom(new InternetAddress(from, true));
            mime.setRecipient(jakarta.mail.Message.RecipientType.TO, new InternetAddress(EmailAddress.canonicalize(message.recipient()), true));
            mime.setSubject(message.subject(), "UTF-8");
            mime.setText(message.body(), "UTF-8");
            mime.setHeader("Message-ID", "<" + java.util.UUID.fromString(message.id()) + "@" + from.substring(from.indexOf('@') + 1) + ">");
            mime.setHeader("Auto-Submitted", "auto-generated");
            sender.send(mime);
        } catch (MessagingException | MailException | IllegalArgumentException failed) {
            throw new DeliveryFailed();
        }
    }
}
