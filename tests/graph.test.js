'use strict';
// Static validation of the six workflow JSON files as n8n will import them.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runTests } = require('./lib/t');
const { ROOT, FILES, CFG } = require('./lib/harness');
const build = require(path.join(ROOT, 'tools', 'build-workflows.js'));

const load = (k) => JSON.parse(fs.readFileSync(path.join(ROOT, FILES[k]), 'utf8'));
const ALL = Object.keys(FILES);
function* strings(o, p) {
  if (typeof o === 'string') { yield [p, o]; return; }
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) yield* strings(o[i], p + '[' + i + ']'); return; }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) yield* strings(o[k], p + '.' + k);
}

test('G1 every workflow file parses and has nodes + connections', () => {
  for (const k of ALL) { const w = load(k); assert.ok(Array.isArray(w.nodes) && w.nodes.length, k); assert.ok(w.connections && typeof w.connections === 'object', k); }
});

test('G2 node names and ids are unique per workflow', () => {
  for (const k of ALL) {
    const w = load(k);
    const names = w.nodes.map((n) => n.name), ids = w.nodes.map((n) => n.id);
    assert.strictEqual(new Set(names).size, names.length, k + ': duplicate node names');
    assert.strictEqual(new Set(ids).size, ids.length, k + ': duplicate node ids');
  }
});

test('G3 every connection source/target exists and output indexes are valid', () => {
  for (const k of ALL) {
    const w = load(k); const names = new Set(w.nodes.map((n) => n.name));
    for (const src of Object.keys(w.connections)) {
      assert.ok(names.has(src), k + ': connection from missing node ' + src);
      const node = w.nodes.find((n) => n.name === src);
      for (const type of Object.keys(w.connections[src])) {
        const outs = w.connections[src][type];
        if (type === 'main') {
          let max = 1;
          if (node.type === 'n8n-nodes-base.if') max = 2;
          if (node.type === 'n8n-nodes-base.switch') max = node.parameters.rules.values.length + (node.parameters.options && node.parameters.options.fallbackOutput === 'extra' ? 1 : 0);
          if (node.onError === 'continueErrorOutput') max += 1;
          assert.ok(outs.length <= max, k + ': ' + src + ' has ' + outs.length + ' outputs wired but only ' + max + ' exist');
        }
        for (const o of outs) for (const c of o || []) assert.ok(names.has(c.node), k + ': ' + src + ' -> missing ' + c.node);
      }
    }
  }
});

test('G4 every $("Node") reference in code/expressions resolves to a node in the same workflow', () => {
  for (const k of ALL) {
    const w = load(k); const names = new Set(w.nodes.map((n) => n.name));
    for (const n of w.nodes) for (const [p, s] of strings(n.parameters, n.name)) {
      for (const m of s.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) assert.ok(names.has(m[1]), k + ': ' + p + ' references missing node ' + m[1]);
      for (const m of s.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)) assert.ok(names.has(m[1]), k + ': ' + p + ' references missing node ' + m[1]);
    }
  }
});

test('G5 no orphaned nodes (only the intentionally disabled Groq fallback)', () => {
  for (const k of ALL) {
    const w = load(k); const seen = new Set();
    for (const src of Object.keys(w.connections)) { seen.add(src); for (const t of Object.keys(w.connections[src])) for (const o of w.connections[src][t]) for (const c of o || []) seen.add(c.node); }
    const orphans = w.nodes.filter((n) => !seen.has(n.name) && !n.disabled).map((n) => n.name);
    assert.deepStrictEqual(orphans, [], k + ' orphans');
  }
});

test('G6 no main-workflow node still resolves Dedup via fragile paired-item .item', () => {
  const w = load('main');
  for (const n of w.nodes) for (const [p, s] of strings(n.parameters, n.name)) assert.ok(s.indexOf("$('Dedup & Filter Prep').item") < 0, p);
});

test('G7 no secrets in any workflow or project file', () => {
  const dirs = ['engine', 'tools', 'tests', path.join('tests', 'lib'), 'pre-fix-backups', 'backups-before-concurrency-cycle'].filter((d) => fs.existsSync(path.join(ROOT, d)));
  const files = fs.readdirSync(ROOT).filter((f) => /\.(json|md|js)$/.test(f)).map((f) => path.join(ROOT, f))
    .concat(dirs.flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => /\.(js|json|md)$/.test(f)).map((f) => path.join(ROOT, d, f))));
  const bad = [/EAA[A-Za-z0-9]{40,}/, /sk-[A-Za-z0-9_-]{20,}/, /AIza[0-9A-Za-z_-]{30,}/, /ya29\.[0-9A-Za-z_-]{20,}/, /"accessToken"\s*:\s*"[A-Za-z0-9]{20,}"/, /Bearer [A-Za-z0-9._-]{30,}/];
  for (const f of files) {
    if (/package-lock\.json$/.test(f)) continue;
    const s = fs.readFileSync(f, 'utf8');
    for (const re of bad) assert.ok(!re.test(s), 'possible secret ' + re + ' in ' + f);
  }
  const main = JSON.stringify(load('main'));
  assert.ok(main.indexOf("$env.LUMIERE_WHATSAPP_ACCESS_TOKEN") >= 0, 'token must come from env');
});

test('G8 tool schemas match sub-workflow inputs (every field wired, none missing)', () => {
  const main = load('main');
  const map = { Book_Appointment: 'book', Cancel_Appointment: 'cancel', Reschedule_Appointment: 'reschedule', Find_Patient_Appointments: 'find', Check_Availability: 'check' };
  for (const tool of Object.keys(map)) {
    const t = main.nodes.find((n) => n.name === tool);
    const sub = load(map[tool]);
    assert.strictEqual(t.parameters.workflowId.value, sub.id, tool + ' points at the wrong workflow id');
    const trigger = sub.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
    const inputs = trigger.parameters.workflowInputs.values.map((v) => v.name).sort();
    const wired = Object.keys(t.parameters.workflowInputs.value).sort();
    const schema = t.parameters.workflowInputs.schema.map((s) => s.id).sort();
    assert.deepStrictEqual(wired, inputs, tool + ': wired fields != sub-workflow inputs');
    assert.deepStrictEqual(schema, inputs, tool + ': schema != sub-workflow inputs');
    // phone_number is never taken from the LLM
    if (t.parameters.workflowInputs.value.phone_number) assert.ok(t.parameters.workflowInputs.value.phone_number.indexOf('$fromAI') < 0, tool + ': phone_number must come from the WhatsApp sender');
  }
});

test('G9 sub-workflows return {result} on every path, including an engine crash', () => {
  for (const k of ['book', 'cancel', 'reschedule']) {
    const w = load(k);
    const route = w.connections['Engine: Route'].main;
    assert.deepStrictEqual(route[3].map((c) => c.node), ['Format Result'], k);
    assert.deepStrictEqual(w.connections['Format Result'].main[0], [], k + ': Format Result must be terminal on success');
    const failed = w.nodes.find((n) => n.name === 'Engine Failed - Result');
    assert.ok(failed && failed.type === 'n8n-nodes-base.set' && !w.connections['Engine Failed - Result'], k + ': crash result must be a terminal Set node');
    for (const n of ['Engine: Start', 'Engine: Decide', 'Engine: Collect', 'Format Result']) {
      const node = w.nodes.find((x) => x.name === n);
      assert.strictEqual(node.onError, 'continueErrorOutput', k + '/' + n);
      assert.deepStrictEqual(w.connections[n].main[1].map((c) => c.node), ['Engine Failed - Result'], k + '/' + n + ' crash output');
    }
  }
});

test('G10 engine code embedded in every workflow is identical to engine/engine.js (no drift)', () => {
  const src = build.engineSource();
  let n = 0;
  for (const k of ALL) for (const node of load(k).nodes) {
    const c = node.parameters && node.parameters.jsCode;
    if (typeof c === 'string' && c.indexOf('function createEngine(') >= 0) { n++; assert.ok(c.indexOf(src) >= 0, k + '/' + node.name + ' has a stale engine copy'); }
  }
  assert.strictEqual(n, 6, 'expected the engine in 4 Decide nodes + Find + Check');
});

test('G11 build is idempotent and the committed JSON is up to date', () => {
  const out = build.build();
  for (const k of ALL) assert.strictEqual(JSON.stringify(out[k], null, 2) + '\n', fs.readFileSync(path.join(ROOT, FILES[k]), 'utf8'), k + ' is not what the build produces - run node tools/build-workflows.js');
});

test('G12 every generated Code node compiles (syntax check of the exact embedded code)', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const k of ALL) for (const node of load(k).nodes) {
    if (node.type !== 'n8n-nodes-base.code') continue;
    try { new AsyncFunction('$input', '$', '$json', '$env', '$execution', '$runIndex', '$getWorkflowStaticData', 'DateTime', node.parameters.jsCode); }
    catch (e) { assert.fail(k + '/' + node.name + ' does not compile: ' + e.message); }
  }
});

test('G13 engine HTTP nodes use the stored Google credential, response status, a timeout, and a real JSON body for writes', () => {
  for (const k of ['main', 'book', 'cancel', 'reschedule']) {
    const w = load(k);
    for (const [name, withBody] of [['Engine: Calendar API', false], ['Engine: Calendar API (write)', true]]) {
      const n = w.nodes.find((x) => x.name === name);
      assert.ok(n, k + ': missing ' + name);
      assert.strictEqual(n.parameters.authentication, 'predefinedCredentialType');
      assert.strictEqual(n.parameters.nodeCredentialType, 'googleCalendarOAuth2Api');
      assert.deepStrictEqual(n.credentials.googleCalendarOAuth2Api, CFG.GOOGLE_CALENDAR_CREDENTIAL);
      assert.strictEqual(n.parameters.options.response.response.fullResponse, true);
      assert.strictEqual(n.parameters.options.response.response.neverError, true);
      assert.ok(n.parameters.options.timeout > 0 && n.parameters.options.timeout < CFG.LEASE_MARGIN_MS, 'HTTP timeout must be shorter than the lease margin');
      assert.ok(!n.retryOnFail, 'engine HTTP must not auto-retry (non-idempotent POST is handled by the engine)');
      assert.strictEqual(n.parameters.sendBody, withBody, k + '/' + name + ': sendBody must be the literal ' + withBody);
      if (withBody) { assert.strictEqual(n.parameters.specifyBody, 'json'); assert.ok(/req\.body/.test(n.parameters.jsonBody)); }
    }
    const rules = w.nodes.find((x) => x.name === 'Engine: Route').parameters.rules.values;
    assert.ok(/req\.body/.test(rules[0].conditions.conditions[0].leftValue), k + ': requests with a body must route to the write node');
  }
});

test('G16 no n8n toggle that reveals other parameters is an expression (n8n would silently drop them)', () => {
  // n8n evaluates displayOptions against the RAW parameter value, so an
  // expression here hides the dependent parameters (this broke writes live).
  const toggles = ['sendBody', 'sendHeaders', 'sendQuery', 'specifyBody', 'specifyHeaders', 'specifyQuery', 'contentType', 'authentication', 'nodeCredentialType', 'genericAuthType', 'resume', 'mode', 'operation', 'resource'];
  for (const k of ALL) for (const n of load(k).nodes) {
    for (const t of toggles) {
      const v = n.parameters && n.parameters[t];
      assert.ok(!(typeof v === 'string' && v.charAt(0) === '='), k + '/' + n.name + ': ' + t + ' is an expression');
    }
  }
});

test('G14 timing invariants between leases, waits, timeouts', () => {
  assert.ok(CFG.CAL_LOCK_MAX_WAIT_MS > CFG.CAL_LOCK_TTL_MS, 'calendar waiters must outlive a crashed holder lease');
  assert.ok(CFG.CHAT_MAX_WAIT_MS > CFG.CHAT_LOCK_TTL_MS, 'chat waiters must outlive a crashed holder lease');
  assert.ok(CFG.CHAT_WAITER_TTL_MS > CFG.CHAT_MAX_WAIT_MS, 'live waiters must never be pruned');
  assert.ok(CFG.LEASE_MARGIN_MS > CFG.HTTP_TIMEOUT_MS, 'a write must finish (or time out) before the lease can expire');
  assert.ok(CFG.MAIN_EXECUTION_TIMEOUT_S * 1000 >= CFG.CHAT_MAX_WAIT_MS + CFG.CHAT_LOCK_TTL_MS, 'main execution timeout too short for wait + processing');
  assert.ok(CFG.TOOL_EXECUTION_TIMEOUT_S * 1000 >= CFG.OP_DEADLINE_MS + 30000, 'tool execution timeout too short');
  assert.ok(/^[0-9a-v]{5,1024}$/.test(CFG.CAL_LOCK_ID) && /^[0-9a-v]+$/.test(CFG.CHAT_LOCK_PREFIX), 'lock ids must be base32hex');
  for (const k of ALL) { const w = load(k); if (['main', 'book', 'cancel', 'reschedule'].indexOf(k) >= 0) assert.ok(w.settings.executionTimeout > 0, k + ' needs an execution timeout'); }
});

test('G15 every patient-message terminal path in the main workflow reaches Chat Lock: Release', () => {
  const w = load('main');
  const next = (n) => { const c = w.connections[n]; return c && c.main ? c.main.flat().filter(Boolean).map((x) => x.node) : []; };
  // walk forward from lock acquisition; every sink must be Release, the release/ duplicate ends, or inside the engine loop
  const allowedSinks = new Set(['Chat Lock Released', 'Duplicate Message - Stop', 'Release Failed - Lease Expires']);
  const seen = new Set(); const sinks = new Set();
  const stack = ['Chat Lock Acquired'];
  while (stack.length) {
    const n = stack.pop(); if (seen.has(n)) continue; seen.add(n);
    const nx = next(n);
    if (!nx.length) sinks.add(n);
    for (const x of nx) stack.push(x);
  }
  for (const s of sinks) assert.ok(allowedSinks.has(s), 'path ends at ' + s + ' without releasing the chat lock');
  assert.ok(seen.has('Chat Lock: Release'));
});

test('G17 main workflow: every lock-step Code node has a crash output to the loop-proof safety net', () => {
  const w = load('main');
  const IF = 'Lock Step Failed - Before Release?';
  for (const n of ['Chat Lock: Acquire', 'Chat Lock: Release', 'Engine: Decide', 'Engine: Collect']) {
    assert.strictEqual(w.nodes.find((x) => x.name === n).onError, 'continueErrorOutput', n);
    assert.deepStrictEqual(w.connections[n].main[1].map((c) => c.node), [IF], n + ' crash output');
  }
  const f = w.nodes.find((x) => x.name === IF);
  assert.strictEqual(f.type, 'n8n-nodes-base.if', 'safety net must not be a Code node (the Code runner may be down)');
  assert.ok(/\$\('Chat Lock: Release'\)\.isExecuted/.test(f.parameters.conditions.conditions[0].leftValue));
  assert.deepStrictEqual(w.connections[IF].main.map((o) => o.map((c) => c.node)), [['Send Fallback Reply'], ['Release Failed - Lease Expires']]);
});

test('G18 lookups of a node with an error output are pinned to output 0 (n8n would otherwise read the empty error branch)', () => {
  // Found live: n8n resolves $('X').first() with no output index through the output of X
  // that leads to the current node; Chat Lock Acquired -> error -> fallback -> Chat Lock: Release
  // made the release read nothing (wasHolder false, confirmation notes lost).
  const files = [FILES.main, 'Lumiere Messenger AI Agent.json', path.join('website-demo', 'Lumiere Salon - Website Demo.json')];
  let pinned = 0;
  for (const f of files) {
    const w = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const errOut = new Set(w.nodes.filter((n) => n.onError === 'continueErrorOutput').map((n) => n.name));
    for (const n of w.nodes) {
      const t = JSON.stringify(n.parameters);
      for (const m of t.matchAll(/\$\('([^']+)'\)\.(first|last|all)\(([^)]*)\)/g)) {
        if (!errOut.has(m[1])) continue;
        assert.ok(m[3] !== '', f + ' / ' + n.name + ': $(\'' + m[1] + '\').' + m[2] + '() needs an explicit output index');
        pinned++;
      }
    }
  }
  assert.ok(pinned >= 10, 'lookups checked (' + pinned + ')');
});

test('G19 a failed handoff-sheet read never ALSO continues to the normal reply (WhatsApp + Messenger)', () => {
  // Found live: "Always Output Data" + error output -> n8n runs BOTH branches when the read fails.
  for (const f of [FILES.main, 'Lumiere Messenger AI Agent.json']) {
    const w = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const n of w.nodes.filter((x) => x.alwaysOutputData && x.onError === 'continueErrorOutput')) {
      const next = ((w.connections[n.name] || {}).main || [])[0] || [];
      assert.ok(next.length, f + ' / ' + n.name + ' has a main output');
      for (const c of next) {
        const code = (w.nodes.find((x) => x.name === c.node).parameters || {}).jsCode || '';
        assert.ok(code.indexOf("if ($('" + n.name + "').all(1).length) return [];") >= 0, f + ' / ' + c.node + ' must stop when ' + n.name + ' failed');
      }
    }
  }
});

if (require.main === module) runTests('graph').then((r) => process.exit(r.fail ? 1 : 0));
