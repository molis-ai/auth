-- One key, so all checks and deletion are atomic on a Redis Cluster slot as well.
if ARGV[1] == 'create' then
    if redis.call('EXISTS', KEYS[1]) == 1 then return {} end
    redis.call('HSET', KEYS[1], 'binding', ARGV[2], 'payload', ARGV[3])
    redis.call('PEXPIRE', KEYS[1], 300000)
    return {'OK'}
end
if ARGV[1] ~= 'consume' then return {} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 or ttl > 300000 then
    redis.call('DEL', KEYS[1])
    return {}
end
if redis.call('HGET', KEYS[1], 'binding') ~= ARGV[2] then return {} end
local payload = redis.call('HGET', KEYS[1], 'payload')
redis.call('DEL', KEYS[1])
if not payload then return {} end
return {payload}
