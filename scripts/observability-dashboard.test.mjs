import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('Grafana v2 dashboard matches its generator and monitoring contract', () => {
  const generator = fileURLToPath(new URL('../docs/observability/build-auth-dashboard.mjs', import.meta.url))
  const checkedIn = readFileSync(new URL('../docs/observability/grafana-auth-dashboard.json', import.meta.url), 'utf8')
  assert.equal(execFileSync(process.execPath, [generator, '--stdout'], { encoding: 'utf8' }), checkedIn)
  const dashboard = JSON.parse(checkedIn)
  assert.equal(dashboard.apiVersion, 'dashboard.grafana.app/v2')
  assert.equal(dashboard.metadata.name, 'molis-auth-observability-v2')
  const { elements, layout, links, tags, variables } = dashboard.spec
  assert.ok(tags.includes('molis'))
  assert.deepEqual(Object.keys(elements), ["kpi-availability","kpi-errors","kpi-login","kpi-browser","kpi-cleanup","b1","b2","b3","b4","b5","f1","f2","f3","f4","f5","k1","k2","k3","k4","k5","k6"])
  const dashboardTabs = layout.spec.rows[1].spec.layout
  assert.equal(dashboardTabs.kind, 'TabsLayout')
  assert.deepEqual(dashboardTabs.spec.tabs.map((tab) => tab.spec.title), ["业务指标","前端指标","后端指标"])
  const env = variables.find((variable) => variable.spec.name === 'env').spec
  assert.equal(env.multi, false)
  assert.equal(env.includeAll, false)
  assert.equal(env.allowCustomValue, false)
  assert.deepEqual(env.options.map((option) => option.value), ['prod', 'test'])
  const datasource = variables.find((variable) => variable.spec.name === 'datasource').spec
  assert.equal(datasource.pluginId, 'loki')
  assert.equal(datasource.current.value, '')
  assert.equal(links[0].keepTime, true)
  assert.equal(links[0].url, '/d/molis-billing-observability-v2/molis-billing-observability-v2?${env:queryparam}')
  const trace = elements.k6.spec.data.spec.queries[0].spec.query.spec.expr
  assert.match(trace, /molis-\(auth\|billing\)-\(production\|test\)/u)
  assert.ok(trace.includes('app_env="${env:raw}"'))
  assert.ok(trace.includes('request_id=${request_id:doublequote}'))
  const rule = dashboardTabs.spec.tabs.at(-1).spec.layout.spec.rows[1].spec
    .conditionalRendering.spec.items[0].spec
  assert.equal(rule.variable, 'request_id')
  assert.equal(rule.operator, 'matches')
  assert.equal(new RegExp(rule.value).test(''), false)
  assert.equal(new RegExp(rule.value).test('e9493c36-4792-4b70-a522-ee4b0304300a'), true)
})
