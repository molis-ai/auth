-- Single-key state machine; all operations preserve the original TTL.
local action = ARGV[1]
if action == 'create' then
    if redis.call('EXISTS', KEYS[1]) ~= 0 then return {} end
    redis.call('HSET', KEYS[1], 'data', ARGV[2], 'status', 'READY', 'attempts', '0')
    redis.call('PEXPIRE', KEYS[1], 600000)
    return {'OK'}
end
if redis.call('PTTL', KEYS[1]) <= 0 then return {} end
if (action == 'preview' or action == 'bind-completion' or action == 'confirmed-complete')
    and redis.call('PTTL', KEYS[1]) > 600000 then return {} end
local data = redis.call('HGET', KEYS[1], 'data')
local status = redis.call('HGET', KEYS[1], 'status')
if not data or not status then return {} end
if action == 'read' then return {data, status} end
if action == 'preview' and status == 'AUTHENTICATED' then
    local root = redis.call('HGET', KEYS[1], 'root')
    if root then return {data, root} end
    return {}
end
if action == 'bind-completion' and status == 'AUTHENTICATED' then
    local root = redis.call('HGET', KEYS[1], 'root')
    local browser = redis.call('HGET', KEYS[1], 'completion-browser')
    if not root or root ~= ARGV[4] or (browser and browser ~= ARGV[2]) then return {} end
    redis.call('HSET', KEYS[1], 'completion-browser', ARGV[2], 'completion-proof', ARGV[3])
    return {tostring(redis.call('PTTL', KEYS[1]))}
end
if action == 'confirmed-complete' and status == 'AUTHENTICATED' then
    local root = redis.call('HGET', KEYS[1], 'root')
    if not root or redis.call('HGET', KEYS[1], 'completion-browser') ~= ARGV[2]
        or redis.call('HGET', KEYS[1], 'completion-proof') ~= ARGV[3] then return {} end
    redis.call('DEL', KEYS[1])
    return {data, root}
end
if action == 'claim' and status == 'READY' then
    redis.call('HSET', KEYS[1], 'status', 'BUSY', 'owner', ARGV[2])
    return {data}
end
if action == 'owned' and status == 'BUSY' and redis.call('HGET', KEYS[1], 'owner') == ARGV[2] then
    return {data}
end
if (action == 'authenticated' or action == 'denied') and status == 'BUSY'
    and redis.call('HGET', KEYS[1], 'owner') == ARGV[2] then
    redis.call('HDEL', KEYS[1], 'owner')
    if action == 'authenticated' then
        redis.call('HSET', KEYS[1], 'status', 'AUTHENTICATED', 'root', ARGV[3])
    else
        local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
        redis.call('HSET', KEYS[1], 'status', attempts >= 5 and 'FAILED' or 'READY')
    end
    return {'OK'}
end
if action == 'complete' and status == 'AUTHENTICATED' then
    local root = redis.call('HGET', KEYS[1], 'root')
    if not root then return {} end
    redis.call('DEL', KEYS[1])
    return {data, root}
end
if action == 'finish' and status == 'BUSY' and redis.call('HGET', KEYS[1], 'owner') == ARGV[2] then
    redis.call('DEL', KEYS[1])
    return {'OK'}
end
return {}
