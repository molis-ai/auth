ALTER TABLE auth_space_invitation
    ADD COLUMN recipient_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD KEY ix_invitation_recipient (recipient_user_id, status),
    ADD CONSTRAINT fk_invitation_recipient FOREIGN KEY (recipient_user_id) REFERENCES auth_user(id);

-- Only bind historical invitations to accounts already present when they were sent.
-- Registering an address later must not claim a previously issued invitation.
UPDATE auth_space_invitation i
JOIN auth_user_email e ON e.canonical_email = i.invited_email
JOIN auth_user u ON u.id = e.user_id
SET i.recipient_user_id = u.id
WHERE u.created_at <= i.created_at AND e.created_at <= i.created_at;
