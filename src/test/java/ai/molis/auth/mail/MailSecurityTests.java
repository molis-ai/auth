package ai.molis.auth.mail;

import ai.molis.auth.security.TokenSecrets;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import jakarta.mail.Session;
import jakarta.mail.internet.MimeMessage;
import org.junit.jupiter.api.Test;
import org.springframework.mail.MailSendException;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.JavaMailSenderImpl;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class MailSecurityTests {
    // Test-only known key. Production configuration must supply independent secret keys.
    static final String KEY = Base64.getEncoder().encodeToString(new byte[32]);
    static MailPayloadCipher cipher() { return new MailPayloadCipher("test", Map.of("test", KEY)); }

    @Test void externalMailboxTemplateDoesNotDescribePasswordResetOrAccountMerging() {
        var cipher=cipher();var templates=new MailTemplates(cipher,"https://auth.example.test");
        for(String locale:new String[]{"en","zh-CN"}) {
            var row=new MailOutboxMapper.Row(UUID.randomUUID().toString(),"person@example.test","VERIFY_EXTERNAL_IDENTITY",locale,null,Instant.now().plusSeconds(600),0);
            String challenge=TokenSecrets.generate(),secret=TokenSecrets.generate();
            String payload=cipher.seal(challenge+"\n"+secret,row.context());
            var message=templates.render(new MailOutboxMapper.Row(row.id(),row.recipient(),row.template(),row.locale(),payload,row.expiresAt(),0));
            assertThat(message.subject()).doesNotContain("reset","重置");
            assertThat(message.body()).contains("/verify-email#challenge="+challenge+"&token="+secret);
            assertThat(message.body()).contains(locale.equals("en")?"does not reset a password or merge":"不会重置密码或合并");
        }
    }

    @Test void invitationNoticeUsesOnlyTheAuthConsoleAndNeverCarriesAnAcceptanceCredential(){
        var templates=new MailTemplates(cipher(),"https://auth.example.test");
        for(String locale:new String[]{"en","zh-CN"}){
            var message=templates.render(new MailOutboxMapper.Row(UUID.randomUUID().toString(),"invited@example.test","SPACE_INVITED",locale,null,Instant.now().plusSeconds(86400),0));
            assertThat(message.body()).contains("https://auth.example.test/console").doesNotContain("token=","secret=","/accept", "invited@example.test");
        }
    }

    @Test void encryptedPayloadUsesFreshNonceAndAuthenticatedContext() {
        var cipher = cipher();
        String plaintext = TokenSecrets.generate();
        String first = cipher.seal(plaintext, "mail-a\nreceiver-a"), second = cipher.seal(plaintext, "mail-a\nreceiver-a");
        assertThat(first).isNotEqualTo(second).doesNotContain(plaintext);
        assertThat(cipher.open(first, "mail-a\nreceiver-a")).isEqualTo(plaintext);
        assertThatIllegalArgumentException().isThrownBy(() -> cipher.open(first, "mail-b\nreceiver-a"));
        assertThatIllegalArgumentException().isThrownBy(() -> cipher.open(first, "mail-a\nreceiver-b"));
        String[] parts = first.split("\\.");
        byte[] bytes = Base64.getUrlDecoder().decode(parts[3]); bytes[0] ^= 1;
        parts[3] = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        assertThatIllegalArgumentException().isThrownBy(() -> cipher.open(String.join(".", parts), "mail-a\nreceiver-a"));
    }

    @Test void keyRotationKeepsOldPendingMessagesReadableWithoutLoggingKeys() {
        var old = cipher();
        String pending = old.seal("pending", "context");
        String anotherKey = Base64.getEncoder().encodeToString(TokenSecrets.generate().substring(0, 32).getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        var rotated = new MailPayloadCipher("next", Map.of("test", KEY, "next", anotherKey));
        assertThat(rotated.open(pending, "context")).isEqualTo("pending");
        assertThat(rotated.seal("new", "context")).startsWith("v1.next.");
        assertThatIllegalArgumentException().isThrownBy(() -> new MailPayloadCipher("next", Map.of("next", anotherKey)).open(pending, "context"));
        assertThat(new MailConfiguration.CryptoKeys("test", Map.of("test", KEY)).toString()).doesNotContain(KEY);
        assertThatIllegalArgumentException().isThrownBy(() -> new MailPayloadCipher("test", Map.of("test", "short-secret")))
                .withMessage("Invalid mail encryption key configuration");
    }

    @Test void bilingualTemplatesPutSecretsOnlyInAuthLinkFragment() {
        var cipher = cipher(); var templates = new MailTemplates(cipher, "https://auth.example.test");
        String challenge = TokenSecrets.generate(), secret = TokenSecrets.generate();
        var row = new MailOutboxMapper.Row(UUID.randomUUID().toString(), "person@example.test", "VERIFY_REGISTER", "zh-CN", null,
                Instant.parse("2026-09-14T23:00:00Z"), 0);
        String encrypted = cipher.seal(challenge + "\n" + secret, row.context());
        var message = templates.render(new MailOutboxMapper.Row(row.id(), row.recipient(), row.template(), row.locale(), encrypted, row.expiresAt(), 0));
        assertThat(message.subject()).contains("验证邮箱");
        assertThat(message.body()).contains("https://auth.example.test/verify-email#challenge=" + challenge + "&token=" + secret);
        assertThat(message.toString()).doesNotContain(secret, message.body());
        var notice = templates.render(new MailOutboxMapper.Row(UUID.randomUUID().toString(), row.recipient(), "PASSWORD_CHANGED", "en", null, null, 0));
        assertThat(notice.body()).contains("previous sessions were signed out");
        assertThatIllegalArgumentException().isThrownBy(() -> new MailTemplates(cipher, "http://public.example.test"));
        assertThatIllegalArgumentException().isThrownBy(() -> new MailTemplates(cipher, "https://auth.example.test/?redirect=evil"));
    }

    @Test void smtpAdapterBuildsUtf8MessageAndRemovesUnderlyingFailureDetails() throws Exception {
        var sender = mock(JavaMailSender.class);
        var mime = new MimeMessage(Session.getInstance(new Properties()));
        when(sender.createMimeMessage()).thenReturn(mime);
        var transport = new SmtpMailTransport(sender, "auth@example.test");
        String id = UUID.randomUUID().toString();
        transport.send(new MailTransport.Message(id, "person@example.test", "验证邮箱", "中文邮件内容"));
        verify(sender).send(mime);
        assertThat(mime.getSubject()).isEqualTo("验证邮箱");
        assertThat(mime.getContent()).isEqualTo("中文邮件内容");
        assertThat(mime.getHeader("Message-ID", null)).isEqualTo("<" + id + "@example.test>");
        doThrow(new MailSendException("private provider secret detail")).when(sender).send(any(MimeMessage.class));
        assertThatThrownBy(() -> transport.send(new MailTransport.Message(id, "person@example.test", "subject", "secret body")))
                .isInstanceOf(MailTransport.DeliveryFailed.class).hasMessage("MAIL_DELIVERY_FAILED").hasNoCause();
    }

    @Test void explicitTransportConfigurationRequiresTlsAndProtectsDevelopmentInbox() {
        var config = new MailConfiguration();
        var transport = config.mailTransport("smtp", "https://auth.example.test", "0.0.0.0", "smtp.example.test", 587,
                "user", "test-only-password", "auth@example.test", false);
        var sender = (JavaMailSenderImpl) org.springframework.test.util.ReflectionTestUtils.getField(transport, "sender");
        assertThat(sender.getJavaMailProperties()).containsEntry("mail.smtp.starttls.required", "true")
                .containsEntry("mail.smtp.ssl.checkserveridentity", "true").containsEntry("mail.smtp.timeout", "5000");
        assertThatIllegalArgumentException().isThrownBy(() -> config.mailTransport("inbox", "https://auth.example.test", "127.0.0.1",
                "", 0, "", "", "", false));
        assertThatIllegalArgumentException().isThrownBy(() -> config.mailTransport("inbox", "http://localhost:8080", "0.0.0.0",
                "", 0, "", "", "", false));
    }
}
