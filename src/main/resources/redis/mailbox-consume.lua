local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 or redis.call('HGET', KEYS[1], 'state') ~= 'VERIFIED' then return {} end
if redis.call('HGET', KEYS[1], 'purpose') ~= ARGV[1]
    or redis.call('HGET', KEYS[1], 'binding') ~= ARGV[2] then return {} end
local operation = redis.call('HGET', KEYS[1], 'operation')
local email = redis.call('HGET', KEYS[1], 'email')
if not operation or not email then return {} end
redis.call('DEL', KEYS[1])
return {operation, email}
