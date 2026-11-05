-- Opt-in, synthetic accounts only; run after the unified local registration and 0007.
INSERT OR IGNORE INTO auth_mock_provider_account(id,environment_id,provider,subject,label)
SELECT 'mock-google-local','unified-local','GOOGLE','google-fixture-1','Google 测试账号'
FROM auth_environment WHERE id='unified-local' AND kind='LOCAL' AND provider_mode='MOCK';
INSERT OR IGNORE INTO auth_mock_provider_account(id,environment_id,provider,subject,label)
SELECT 'mock-github-local','unified-local','GITHUB','github-fixture-1','GitHub 测试账号（无邮箱）'
FROM auth_environment WHERE id='unified-local' AND kind='LOCAL' AND provider_mode='MOCK';
