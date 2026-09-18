-- Preserve the original delivery history. Each original notification may have one manual retry batch.
ALTER TABLE auth_mail_outbox
    ADD COLUMN resend_of CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD UNIQUE KEY uk_mail_resend_original (resend_of),
    ADD CONSTRAINT fk_mail_resend_original FOREIGN KEY (resend_of) REFERENCES auth_mail_outbox(id);
