-- Password signup reserves a login identifier, not proof of mailbox ownership.
ALTER TABLE auth_user_email MODIFY COLUMN verified_at TIMESTAMP(6) NULL;
