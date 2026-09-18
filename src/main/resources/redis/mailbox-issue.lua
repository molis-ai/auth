-- One hash key per challenge; issuance and TTL are atomic, including on Redis Cluster.
if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
redis.call('HSET', KEYS[1], 'operation', ARGV[1], 'email', ARGV[2], 'purpose', ARGV[3],
    'binding', ARGV[4], 'secret', ARGV[5], 'state', 'PENDING', 'attempts', '0')
redis.call('PEXPIRE', KEYS[1], ARGV[6])
return 1
