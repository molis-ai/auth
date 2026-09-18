local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 or redis.call('HGET', KEYS[1], 'state') ~= 'PENDING' then return 0 end
if redis.call('HGET', KEYS[1], 'secret') ~= ARGV[1] then
    local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
    if attempts >= 5 then redis.call('DEL', KEYS[1]) end
    return 0
end
redis.call('HSET', KEYS[1], 'state', 'VERIFIED')
redis.call('HDEL', KEYS[1], 'secret')
-- Verification must not reset or extend the original lifetime.
return 1
