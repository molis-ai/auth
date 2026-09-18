-- Single slot. Browser binding is checked before either inspection or destructive consumption.
if ARGV[1] == 'create' then
    local ttl = tonumber(ARGV[4])
    if not ttl or ttl < 1 or ttl > 300000 or redis.call('EXISTS', KEYS[1]) == 1 then return {} end
    redis.call('HSET', KEYS[1], 'binding', ARGV[2], 'payload', ARGV[3])
    redis.call('PEXPIRE', KEYS[1], ttl)
    return {'OK'}
end
if ARGV[1] ~= 'read' and ARGV[1] ~= 'consume' then return {} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 or ttl > 300000 then return {} end
if redis.call('HGET', KEYS[1], 'binding') ~= ARGV[2] then return {} end
local payload = redis.call('HGET', KEYS[1], 'payload')
if not payload then return {} end
if ARGV[1] == 'consume' then redis.call('DEL', KEYS[1]) end
return {payload}
