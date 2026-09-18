-- First-request anchored fixed window. Rejects do not extend a lockout indefinitely.
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('PTTL', KEYS[1])
if not count or count < 0 or count ~= math.floor(count) or ttl == -1 then return {-1, 0} end
if count >= tonumber(ARGV[1]) then return {0, ttl} end
count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return {1, redis.call('PTTL', KEYS[1])}
