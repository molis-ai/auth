import { writeFileSync } from 'node:fs'

// Auth 监控看板, modeled on the three-tab design reviewed in antigravity.
const dashboardUid = 'molis-auth-observability-v2'
const source = '${datasource}'
const range = '$__range'
const activityWindow = '$__auto'
const env = '"${env:raw}"'
const panels = {}

function logs(event, fields = [], { billing = false, requestId = false, aliases = {} } = {}) {
  const worker = billing ? 'molis-(auth|billing)-(production|test)' : 'molis-auth-(production|test)'
  const service = billing ? 'molis-auth|molis-billing' : 'molis-auth'
  const extract = [
    'app_service="service"', 'app_env="env"', 'app_event="event"', 'app_schema="schema"',
    ...fields.map((field) => `${field}="${field}"`),
    ...Object.entries(aliases).map(([label, field]) => `${label}="${field}"`),
  ]
  return [
    `{service_name=~".+"} ${requestId ? '|= ${request_id:doublequote}' : `|~ "${event}"`}`,
    `| cloudflare_script_name=~"${worker}"`,
    '| json cf_message="message"',
    '| line_format `{{ .cf_message | default (__line__) }}`',
    '| drop cf_message',
    `| json ${extract.join(', ')}`,
    `| __error__="" | app_service=~"${service}" | app_env=${env} | app_schema="1"`,
    ...(requestId ? ['| request_id=~".+" | request_id=${request_id:doublequote}'] : [`| app_event=~"${event}"`]),
  ].join('\n')
}

function stream(event, fields, filter = '') {
  return `${logs(event, fields)}${filter ? `\n${filter}` : ''}`
}

function aggregate(base, { group = [], window = range, operation = 'count_over_time' } = {}) {
  return `sum${group.length ? ` by (${group.join(', ')})` : ''} (${operation}(\n${base}\n${group.length ? `| keep ${group.join(', ')}\n` : '| keep app_service\n'}[${window}]))`
}

function percentile(base, field, group, q, window = range) {
  return `quantile_over_time(${q},\n${base}\n| keep ${[...group, field].join(', ')}\n| unwrap ${field} | __error__=""\n[${window}]) by (${group.join(', ')})`
}

function ratio(good, all, empty = 'vector(0)') {
  return `((${good}) or (${empty})) / (${all})`
}

function query(expr, legendFormat, queryType = 'range') {
  return { expr, ...(legendFormat ? { legendFormat } : {}), queryType }
}

function instant(expr, legend) { return query(expr, legend, 'instant') }

const standard = {
  timeseries: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true, calcs: [] }, tooltip: { mode: 'multi', sort: 'desc' } },
  stat: { orientation: 'auto', textMode: 'value', colorMode: 'value', graphMode: 'none', justifyMode: 'center', reduceOptions: { calcs: ['lastNotNull'], values: false } },
  table: { showHeader: true, cellHeight: 'sm' },
  piechart: { pieType: 'donut', displayLabels: ['percent'], legend: { displayMode: 'table', placement: 'bottom', showLegend: true, values: ['value', 'percent'] }, reduceOptions: { calcs: ['lastNotNull'], values: false } },
  bargauge: { orientation: 'horizontal', displayMode: 'basic', textMode: 'value_and_name', namePlacement: 'left', showUnfilled: true, reduceOptions: { calcs: ['lastNotNull'], values: false } },
  logs: { showTime: true, showLabels: false, showCommonLabels: false, wrapLogMessage: true, enableLogDetails: true, sortOrder: 'Ascending', dedupStrategy: 'none', prettifyLogMessage: true },
}

function panel(key, title, kind, description, queries, { unit, thresholds, overrides = [], options = {}, transformations = [], subtitle } = {}) {
  const id = Object.keys(panels).length + 1
  const plugin = kind
  const isSeries = kind === 'timeseries'
  panels[key] = { kind: 'Panel', spec: {
    id, title, description, ...(subtitle ? { subtitle } : {}), links: [],
    data: { kind: 'QueryGroup', spec: {
      queries: queries.map((spec, index) => ({ kind: 'PanelQuery', spec: {
        refId: String.fromCharCode(65 + index), hidden: false,
        query: { kind: 'DataQuery', group: 'loki', version: 'v0', datasource: { name: source }, spec: { editorMode: 'code', ...spec } },
      } })),
      transformations: transformations.map(({ kind, options }) => ({ kind: 'Transformation', group: kind, spec: { options } })),
      queryOptions: { maxDataPoints: 360 },
    } },
    vizConfig: { kind: 'VizConfig', group: plugin, version: '13.0.0', spec: {
      options: { ...standard[kind], ...options },
      fieldConfig: { defaults: {
        ...(unit ? { unit } : {}),
        ...(kind === 'bargauge' ? { displayName: '${__field.name}' } : {}),
        noValue: '—',
        color: { mode: thresholds ? 'thresholds' : 'palette-classic' },
        ...(isSeries ? { custom: { drawStyle: 'line', lineInterpolation: 'linear', lineWidth: 2, fillOpacity: 12, showPoints: 'never', spanNulls: false } } : {}),
        ...(thresholds ? { thresholds: { mode: 'absolute', steps: thresholds } } : {}),
      }, overrides },
    } },
  } }
  return key
}

const green = (value = null) => ({ color: 'green', value })
const red = (value = null) => ({ color: 'red', value })
const warning = (value) => ({ color: 'orange', value })
const info = (value = null) => ({ color: 'blue', value })
const labelOverride = (name, ...properties) => ({ matcher: { id: 'byName', options: name }, properties: properties.map(([id, value]) => ({ id, value })) })
const tableLabels = [{ kind: 'labelsToFields', options: { mode: 'columns' } }, { kind: 'merge', options: {} }]
const categories = [
  { kind: 'filterFieldsByName', options: { exclude: { names: ['Time'] } } },
  { kind: 'rowsToFields', options: { mappings: [{ fieldName: 'category', handlerKey: 'field.name' }] } },
]
const categoryGroup = { group: ['category'] }
const withCategory = (base, template) => base + '\n| label_format category=`' + template + '`'
const metricColumns = (displayNames) => [...tableLabels, {
  kind: 'organize',
  options: {
    excludeByName: { Time: true },
    indexByName: Object.fromEntries(Object.keys(displayNames).map((name, index) => [name, index])),
    renameByName: displayNames,
  },
}]
const coreRouteFilter = '| route=~"/api/(account|v1)/.+" | route!~"/api/(v1/(health|readiness)|account/telemetry)"'
const authRequest = stream('auth[.]http[.]request', ['route', 'method', 'status', 'error_code', 'duration_ms'], coreRouteFilter)
const authLogin = logs('auth[.]login[.]result', ['method', 'outcome', 'error_code', 'new_user', 'entry'])
const authCleanup = logs('auth[.]cleanup', ['duration_ms', 'stop_reason'])
const webSession = logs('auth[.]web[.]session', ['outcome'])
const webVitals = stream('auth[.]web[.]vital', ['page', 'metric', 'value'], '| page=~"${page:raw}"')
const webError = logs('auth[.]web[.]error', ['kind', 'view', 'release'], { aliases: { error_name: 'name' } })
const latestCleanup = `max_over_time(\n${authCleanup}\n| keep duration_ms | unwrap duration_ms | __error__="" [2h])`
const loginOk = aggregate(`${authLogin} | outcome="success"`)
const sessionClean = aggregate(`${webSession} | outcome="clean"`)
const core5xx = aggregate(`${authRequest} | status=~"5[0-9]{2}"`)
const coreResponses = aggregate(`${authRequest} | status=~"[235][0-9]{2}"`)

panel('kpi-availability', '核心 API 可用率', 'stat', '按 2xx、3xx 和 5xx 计算。排除探针、遥测和 4xx。', [instant(`1 - (${ratio(core5xx, coreResponses)})`)], { unit: 'percentunit', thresholds: [red(), warning(0.99), green(0.999)] })
panel('kpi-errors', '5xx 请求错误数', 'stat', '对外响应每个请求计一次。', [instant(`${core5xx} or vector(0)`)], { unit: 'short', thresholds: [green(), warning(6), red(11)] })
panel('kpi-login', '全渠道登录成功率', 'stat', '基于落地的登录结果事件。OAuth 以平台处理提供方回调为准。', [instant(ratio(loginOk, aggregate(authLogin)))], { unit: 'percentunit', thresholds: [red(), warning(0.9), green(0.97)] })
panel('kpi-browser', '前端无报错会话率', 'stat', '样本为页面初次可见至离开前台的一段体验。生产采样 10%。', [instant(ratio(sessionClean, aggregate(webSession)))], { unit: 'percentunit', thresholds: [red(), warning(0.98), green(0.995)] })
panel('kpi-cleanup', 'Cron 定时清理', 'stat', '近两小时最长一次清理运行时间。8 秒为维护预算。', [instant(latestCleanup)], { unit: 'ms', thresholds: [green(), warning(6000), red(8000)] })

const selectedLogin = `${authLogin} | method=~"${'${channel:raw}'}"`
const byMethod = { group: ['method'], window: activityWindow }
const loginAttempts = aggregate(selectedLogin, byMethod)
const loginSuccess = aggregate(`${selectedLogin} | outcome="success"`, byMethod)
panel('b1', '分渠道登录量与成功率趋势', 'timeseries', '密码、邮箱验证码、短信验证码、Google 和 GitHub。登录成功率使用右轴。', [query(loginAttempts, '{{method}} · 登录量'), query(ratio(loginSuccess, loginAttempts, `0 * (${loginAttempts})`), '{{method}} · 成功率')], { overrides: [{ matcher: { id: 'byRegexp', options: '/成功率$/' }, properties: [{ id: 'unit', value: 'percentunit' }, { id: 'custom.axisPlacement', value: 'right' }, { id: 'max', value: 1 }] }] })
const loginCohort = withCategory(`${selectedLogin} | outcome="success" | new_user=~"true|false"`, '{{ if eq .new_user "true" }}新增注册{{ else }}老用户{{ end }} · {{ .entry }}')
panel('b2', '新增注册 vs 老用户登录', 'piechart', '仅使用已确认新用户状态的成功登录。入口可在序列标签中查看。', [instant(aggregate(loginCohort, categoryGroup))], { transformations: categories })
const verification = logs('auth[.]verification[.](sent|verified)', ['channel', 'provider', 'outcome'])
const verCounts = (filter, stage) => aggregate(withCategory(`${verification} ${filter}`, `{{ .channel }} · {{ .provider }} · ${stage}`), categoryGroup)
panel('b3', '验证码发送成功率与核销漏斗', 'bargauge', '同窗聚合，对比实际投递尝试、供应商接受和已核销的验证码。', [instant(verCounts('| app_event="auth.verification.sent"', '发送尝试')), instant(verCounts('| app_event="auth.verification.sent" | outcome="success"', '发送成功')), instant(verCounts('| app_event="auth.verification.verified" | outcome="success"', '核销成功'))], { transformations: categories })
const failedLogin = withCategory(`${selectedLogin} | outcome="failed"`, '{{ .error_code }}')
panel('b4', '登录失败原因 Top 分布', 'bargauge', '包含身份校验、限流和提供方取消。', [instant(`topk(10, ${aggregate(failedLogin, categoryGroup)})`)], { transformations: categories })
panel('b5', '租户与团队协同活跃事件', 'timeseries', '新建租户、发出邀请、接受邀请、完成所有权转移和停启用。按实际提交计数。', [query(aggregate(`${logs('auth[.]tenant[.]event', ['action','outcome'])} | outcome="success"`, { group: ['action'], window: activityWindow }), '{{action}}')])

panel('f1', 'Core Web Vitals 页面加载性能（P75）', 'table', '按页面看 TTFB、FCP、LCP、INP、CLS。CLS 无量纲，其他指标是毫秒。', [instant(percentile(webVitals, 'value', ['page', 'metric'], 0.75))], { transformations: metricColumns({ page: '页面', metric: '指标', 'Value #A': 'P75' }) })
panel('f2', '前端运行时异常与异步分包加载失败', 'timeseries', '按异常类型、页面、白名单异常名和 Worker 版本聚合。', [query(aggregate(webError, { group: ['kind','view','error_name','release'], window: activityWindow }), '{{kind}} · {{view}} · {{error_name}}')])
const oauthPopup = withCategory(logs('auth[.]web[.]oauth_popup', ['provider','outcome']), '{{ .provider }} · {{ .outcome }}')
panel('f3', 'OAuth 登录弹窗体验漏斗', 'bargauge', '各提供方的启动、完成、关闭、拦截、重试和失败。', [instant(aggregate(oauthPopup, categoryGroup))], { transformations: categories })
const apiIssue = logs('auth[.]web[.]api_issue', ['endpoint','status','error_code','degraded','duration_ms'])
const apiGroup = ['endpoint','status','error_code','degraded']
panel('f4', 'AccountClient 浏览器侧接口异常与局部降级', 'table', '按归一化接口、状态、错误码及降级状态查看次数和 P95。', [instant(aggregate(apiIssue, { group: apiGroup })), instant(percentile(apiIssue, 'duration_ms', apiGroup, 0.95))], { transformations: metricColumns({ 'Value #A': '次数', 'Value #B': 'P95', endpoint: '接口', status: '状态', error_code: '错误码', degraded: '降级' }), overrides: [labelOverride('P95', ['unit','ms'])] })
const webCache = logs('auth[.]web[.]cache', ['hits','misses','endpoint'])
const sumCache = (field) => `sum(sum_over_time(\n${webCache}\n| keep ${field} | unwrap ${field} | __error__="" [30m]))`
panel('f5', '控制台 ReadOnlyCache 只读缓存命中率', 'timeseries', '按浏览器聚合真实 GET 读请求的命中和缺失。', [query(`(${sumCache('hits')}) / ((${sumCache('hits')}) + (${sumCache('misses')}))`, '命中率')], { unit: 'percentunit', thresholds: [info()] })

panel('k1', '核心 API 吞吐量 (QPS) 与 5xx 趋势', 'timeseries', '基于五分钟窗口，探针与遥测不进入核心 API 分母。', [query(aggregate(authRequest, { operation: 'rate', window: '5m' }), '核心请求 QPS'), query(`${aggregate(`${authRequest} | status=~"5[0-9]{2}"`, { window: '5m' })} or vector(0)`, '5xx 错误数')], { unit: 'reqps', overrides: [labelOverride('5xx 错误数', ['unit','short'], ['color',{mode:'fixed',fixedColor:'red'}], ['custom.axisPlacement','right'], ['custom.drawStyle','bars'])] })
const routePercentile = (q, label) => instant(`topk(10, ${percentile(withCategory(authRequest, `{{ .method }} {{ .route }} · ${label}`), 'duration_ms', ['category'], q)})`)
panel('k2', '关键路由响应延迟（P50 / P95）', 'bargauge', '按 HTTP 方法和归一化路由比较响应耗时。', [routePercentile(0.5, 'P50'), routePercentile(0.95, 'P95')], { unit: 'ms', transformations: categories })
const dependencies = `${logs('auth[.](upstream|external|aliyun)[.]request', ['upstream','provider','route','action','outcome','duration_ms','http_status','error_code'])}\n| label_format dependency=\`{{ if .upstream }}{{ .upstream }} · {{ .route }}{{ else }}{{ .provider | default "aliyun" }} · {{ .action }}{{ end }}\``
const dependencyGroup = { group: ['dependency'] }
const allDependencies = aggregate(dependencies, dependencyGroup)
const okDependencies = aggregate(`${dependencies} | outcome="success"`, dependencyGroup)
panel('k3', '跨服务与外部依赖健康矩阵（Billing / OAuth / KDF / Aliyun）', 'table', '每个依赖的请求量、成功率、P95 及有日志的失败原因。', [
  instant(allDependencies, '请求量'), instant(ratio(okDependencies, allDependencies, `0 * (${allDependencies})`), '成功率'),
  instant(percentile(dependencies, 'duration_ms', ['dependency'], 0.95), 'P95'),
  instant(`topk(10, ${aggregate(`${dependencies} | outcome!="success" | label_format reason=\`{{ .error_code | default .outcome }}\``, { group: ['dependency','reason'] })})`, '失败数'),
], { transformations: metricColumns({ dependency: '依赖', 'Value #A': '请求量', 'Value #B': '成功率', 'Value #C': 'P95', 'Value #D': '失败数', reason: '失败原因' }), overrides: [labelOverride('成功率',['unit','percentunit']), labelOverride('P95',['unit','ms'])] })
const allHttp = logs('auth[.]http[.]request', ['status','error_code'])
const httpErrors = withCategory(`${allHttp} | status=~"[45][0-9]{2}"`, '{{ .status }} · {{ .error_code }}')
panel('k4', 'Top 4xx / 5xx 错误码分布', 'bargauge', '取窗口内返回次数最多的状态与业务错误码组合。', [instant(`topk(10, ${aggregate(httpErrors, categoryGroup)})`)], { transformations: categories })
const cleanupTimeline = `max_over_time(\n${authCleanup}\n| keep duration_ms | unwrap duration_ms | __error__="" [10m])`
const cleanupFailures = aggregate(logs('auth[.]cleanup[.]failure'), { window: '60m' })
panel('k5', 'Cron 定时清理耗时与 8s 预算红线', 'timeseries', '维护耗时以毫秒计，失败明细按最近一小时计数。', [query(cleanupTimeline, '清理耗时'), query(`${cleanupFailures} or vector(0)`, '失败明细')], { unit: 'ms', thresholds: [green(), red(8000)], overrides: [labelOverride('清理耗时',['custom.thresholdsStyle',{mode:'line'}]), labelOverride('失败明细',['unit','short'],['color',{mode:'fixed',fixedColor:'red'}],['custom.axisPlacement','right'])] })
// Keep this query and its request ID visibility rule identical in the Billing dashboard.
const traceVisibility = { kind: 'ConditionalRenderingGroup', spec: {
  visibility: 'show', condition: 'and', items: [
    { kind: 'ConditionalRenderingVariable', spec: {
      variable: 'request_id', operator: 'matches',
      value: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$',
    } },
  ],
} }
const crossTrace = logs('auth[.]|billing[.]', ['request_id'], { billing: true, requestId: true })
panel('k6', 'X-Request-Id 跨 Auth ↔ Billing 串联日志排障', 'logs', '填入完整 X-Request-Id，以时间排序查看当前环境两项服务实际记录的事件。', [{ ...query(crossTrace), maxLines: 200 }])

function grid(items) {
  return { kind: 'GridLayout', spec: { items: items.map(([name,x,y,width,height]) => ({ kind: 'GridLayoutItem', spec: { x,y,width,height, element: { kind: 'ElementReference', name } } })) } }
}
function row(layout) { return { kind: 'RowsLayoutRow', spec: { hideHeader: true, collapse: false, layout } } }
function tab(title, items) { return { kind: 'TabsLayoutTab', spec: { title, layout: grid(items) } } }
function backendTab(items) {
  const traceRow = row(grid([['k6',0,0,24,11]]))
  traceRow.spec.conditionalRendering = traceVisibility
  return { kind: 'TabsLayoutTab', spec: { title: '后端指标', layout: {
    kind: 'RowsLayout', spec: { rows: [row(grid(items)), traceRow] },
  } } }
}
function custom(name, label, options, defaultValue) {
  const current = options.find(option => option.value === defaultValue)
  return { kind: 'CustomVariable', spec: { name, label, query: options.map(({text,value}) => text === value ? value : `${text} : ${value}`).join(','), options, current, multi:false, includeAll:false, allowCustomValue:false, hide:'dontHide', skipUrlSync:false } }
}
const option = (value,text = value) => ({ text,value })
const resource = {
  apiVersion: 'dashboard.grafana.app/v2', kind: 'Dashboard', metadata: { name: dashboardUid },
  spec: {
    title: 'Molis Auth 监控看板', description: 'Auth 业务指标、前端体验与后端稳定性。环境单选，统一 schema 1。', tags: ['molis','auth','cloudflare','loki'],
    annotations: [], cursorSync: 'Off', editable: true, preload: false,
    elements: panels,
    layout: { kind: 'RowsLayout', spec: { rows: [
      row(grid([['kpi-availability',0,0,5,4],['kpi-errors',5,0,5,4],['kpi-login',10,0,5,4],['kpi-browser',15,0,5,4],['kpi-cleanup',20,0,4,4]])),
      row({ kind:'TabsLayout', spec:{ tabs:[
        tab('业务指标', [['b1',0,0,16,11],['b2',16,0,8,11],['b3',0,11,12,8],['b4',12,11,12,8],['b5',0,19,24,8]]),
        tab('前端指标', [['f1',0,0,24,8],['f2',0,8,14,10],['f3',14,8,10,10],['f4',0,18,14,9],['f5',14,18,10,9]]),
        backendTab([['k1',0,0,14,9],['k2',14,0,10,9],['k3',0,9,14,10],['k4',14,9,10,10],['k5',0,19,24,11]]),
      ] } }),
    ] } },
    links: [{ title:'Molis Billing 看板', type:'link', icon:'external link', tooltip:'打开 Billing 日志看板', url:'/d/molis-billing-observability-v2/molis-billing-observability-v2?${env:queryparam}', tags:[], asDropdown:false, targetBlank:true, includeVars:false, keepTime:true }],
    timeSettings: { from:'now-24h', to:'now', timezone:'browser', autoRefresh:'1m', autoRefreshIntervals:['1m','5m','15m','1h'], quickRanges:['1h','6h','24h','7d'].map(value=>({display:value,from:`now-${value}`,to:'now'})), hideTimepicker:false, weekStart:'monday' },
    variables: [
      { kind:'DatasourceVariable', spec:{ name:'datasource', label:'Loki 数据源', pluginId:'loki', regex:'', current:option(''), options:[], refresh:'onDashboardLoad', multi:false, includeAll:false, allowCustomValue:false, hide:'dontHide', skipUrlSync:false } },
      custom('env','环境',[option('prod','PROD 生产环境'),option('test','TEST 测试环境')],'prod'),
      custom('channel','登录渠道',[option('.+','全渠道'),option('password','密码'),option('email_code','邮箱验证码'),option('phone_otp','短信验证码'),option('google','Google'),option('github','GitHub')],'.+'),
      custom('page','页面',[option('login|account','全部页面'),option('login','登录页'),option('account','账号控制台')],'login|account'),
      { kind:'TextVariable', spec:{ name:'request_id', label:'X-Request-Id', current:option(''), query:'', hide:'dontHide', skipUrlSync:false } },
    ],
  },
}

const output = `${JSON.stringify(resource, null, 2)}\n`
if (process.argv.includes('--stdout')) process.stdout.write(output)
else writeFileSync(new URL('./grafana-auth-dashboard.json', import.meta.url), output)
