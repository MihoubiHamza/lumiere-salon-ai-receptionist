'use strict';
// Minimal n8n workflow interpreter used to execute the REAL workflow JSON in
// tests. It implements the node types the engine and flows depend on, with
// n8n v1 execution-order semantics (depth-first, topmost branch first).
// External nodes (WhatsApp, Sheets, AI Agent...) are provided as test hooks.
let luxon = null;
try { luxon = require('luxon'); } catch (e) { luxon = null; }

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let EXEC_SEQ = 1000;

class KillSignal extends Error { constructor(msg) { super(msg || 'killed'); this.kill = true; } }

class Runner {
  constructor(wf, env) {
    this.wf = wf;
    this.env = env; // { sim, hooks, envVars, persisted, opts }
    this.nodes = new Map(wf.nodes.map((n) => [n.name, n]));
    this.runData = {};
    this.execId = String(++EXEC_SEQ);
    this.trace = [];
    this.staticData = JSON.parse(JSON.stringify(env.persisted.get(wf.name) || {}));
    this.killed = false;
  }

  async run(entryName, items) {
    const { sim } = this.env;
    const deadline = this.wf.settings && this.wf.settings.executionTimeout > 0 && this.env.opts.enforceTimeout
      ? sim.now + this.wf.settings.executionTimeout * 1000 : null;
    const stack = [{ name: entryName, items, entry: true }];
    let lastNode = null, lastOut = null;
    try {
      while (stack.length) {
        if (deadline && sim.now > deadline) throw new KillSignal('execution timeout');
        const job = stack.pop();
        const out = await this.execNode(job.name, job.items, job.entry);
        lastNode = job.name; lastOut = out;
        const conns = (this.wf.connections[job.name] && this.wf.connections[job.name].main) || [];
        const jobs = [];
        out.forEach((its, oi) => {
          if (!its || !its.length) return;
          for (const c of conns[oi] || []) jobs.push({ name: c.node, items: its.map(copyItem), pos: this.pos(c.node) });
        });
        jobs.sort((a, b) => a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0]);
        for (let i = jobs.length - 1; i >= 0; i--) stack.push(jobs[i]);
        if (this.trace.length > 20000) throw new Error('runner: runaway execution');
      }
    } catch (e) {
      if (e.kill) { this.killed = true; return { killed: true, reason: e.message, runner: this }; }
      return { error: e, runner: this };
    }
    this.env.persisted.set(this.wf.name, this.staticData);
    return { ok: true, lastNode, output: lastOut && lastOut[0], runner: this };
  }

  pos(name) { const n = this.nodes.get(name); return (n && n.position) || [0, 0]; }

  async execNode(name, items, isEntry) {
    const node = this.nodes.get(name);
    if (!node) throw new Error('runner: unknown node ' + name);
    if (node.disabled) return [items];
    const runs = (this.runData[name] = this.runData[name] || []);
    const runIndex = runs.length;
    this.trace.push({ node: name, t: this.env.sim.now });
    const maxTries = node.retryOnFail ? node.maxTries || 3 : 1;
    let outputs, lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        if (this.env.hooks.onNode) await this.env.hooks.onNode(name, this, items);
        outputs = await this.execType(node, items, runIndex, isEntry);
        lastErr = null;
        break;
      } catch (e) {
        if (e.kill) throw e;
        lastErr = e;
        if (attempt < maxTries) await this.env.sim.sleep(node.waitBetweenTries != null ? node.waitBetweenTries : 1000);
      }
    }
    if (lastErr) {
      const errItem = { json: { error: lastErr.message || String(lastErr) } };
      if (node.onError === 'continueRegularOutput') outputs = [[errItem]];
      else if (node.onError === 'continueErrorOutput') {
        const n = this.mainOutputs(node); outputs = []; for (let i = 0; i < n; i++) outputs.push([]); outputs.push([errItem]);
        // Like real n8n (seen live 2026-11-24): with "Always Output Data" a failing node ALSO
        // emits an empty item on its main output, so both branches run.
        if (node.alwaysOutputData) outputs[0] = [{ json: {} }];
      }
      else { lastErr.node = name; throw lastErr; }
    }
    runs.push({ outputs });
    return outputs;
  }

  mainOutputs(node) {
    if (node.type === 'n8n-nodes-base.if') return 2;
    if (node.type === 'n8n-nodes-base.switch') return (node.parameters.rules.values || []).length + (node.parameters.options && node.parameters.options.fallbackOutput === 'extra' ? 1 : 0);
    return 1;
  }

  // ---------------------------------------------------------------- context
  accessor() {
    return (name) => {
      const runs = this.runData[name];
      if (!runs || !runs.length) {
        // like n8n: .isExecuted is false, reading its data throws
        const fail = () => { throw new Error("Referenced node is unexecuted: '" + name + "'"); };
        return { isExecuted: false, first: fail, last: fail, all: fail, get item() { return fail(); } };
      }
      const last = runs[runs.length - 1];
      const pick = (b, r) => ((r == null ? last : runs[r]) || { outputs: [] }).outputs[b || 0] || [];
      const self = this;
      return {
        first: (b, r) => pick(b, r)[0],
        last: (b, r) => { const o = pick(b, r); return o[o.length - 1]; },
        all: (b, r) => pick(b, r),
        get item() { if (self.env.opts.itemLinkBroken) throw new Error('Paired item data unavailable'); return pick(0)[0]; },
        isExecuted: true,
      };
    };
  }
  getStatic() {
    return (scope) => {
      if (this.env.opts.staticBroken) return {};
      const key = scope === 'node' ? 'node:' + this.currentNode : 'global';
      if (scope === 'node') { this.staticData[key] = this.staticData[key] || {}; return this.staticData[key]; }
      return this.staticData;
    };
  }
  fakeDate() {
    const sim = this.env.sim;
    return class FakeDate extends Date {
      constructor(...a) { if (a.length === 0) super(sim.now); else super(...a); }
      static now() { return sim.now; }
    };
  }
  fakeMath() { const M = Object.create(Math); M.random = this.env.sim.rng; return M; }
  exprCtx(item, runIndex, inputItems) {
    return {
      $json: item ? item.json : {},
      $binary: item ? item.binary : undefined,
      $input: { all: () => inputItems, first: () => inputItems[0], last: () => inputItems[inputItems.length - 1], item },
      $: this.accessor(),
      $env: this.env.envVars,
      $execution: { id: this.execId },
      $runIndex: runIndex,
      $now: luxon ? luxon.DateTime.fromMillis(this.env.sim.now) : null,
      DateTime: luxon ? luxon.DateTime : undefined,
      $fromAI: () => { throw new Error('$fromAI evaluated outside a tool call'); },
      Date: this.fakeDate(),
      Math: this.fakeMath(),
    };
  }
  evalExpr(v, ctx) {
    if (typeof v !== 'string' || v[0] !== '=') return v;
    const s = v.slice(1);
    const run = (code) => { const names = Object.keys(ctx); return new Function(...names, 'return (' + code + ');')(...names.map((k) => ctx[k])); };
    const whole = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(s);
    if (whole && (s.match(/\{\{/g) || []).length === 1) return run(whole[1]);
    return s.replace(/\{\{([\s\S]*?)\}\}/g, (_, code) => { const r = run(code); return r == null ? '' : typeof r === 'object' ? JSON.stringify(r) : String(r); });
  }

  // ---------------------------------------------------------------- node types
  async execType(node, items, runIndex, isEntry) {
    const hooks = this.env.hooks;
    this.currentNode = node.name;
    if (hooks.nodes && hooks.nodes[node.name]) return norm(await hooks.nodes[node.name](items, this, node));
    const p = node.parameters || {};
    switch (node.type) {
      case 'n8n-nodes-base.executeWorkflowTrigger':
      case 'n8n-nodes-base.whatsAppTrigger':
      case 'n8n-nodes-base.errorTrigger':
      case 'n8n-nodes-base.noOp':
        return [items];
      case 'n8n-nodes-base.code': return [await this.code(node, items, runIndex)];
      case 'n8n-nodes-base.if': return this.ifNode(node, items, runIndex);
      case 'n8n-nodes-base.switch': return this.switchNode(node, items, runIndex);
      case 'n8n-nodes-base.set': return [this.setNode(node, items, runIndex)];
      case 'n8n-nodes-base.wait': {
        const ctx = this.exprCtx(items[0], runIndex, items);
        const amt = Number(this.evalExpr(p.amount, ctx));
        const unit = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }[p.unit || 'hours'];
        await this.env.sim.sleep(amt * unit);
        return [items];
      }
      case 'n8n-nodes-base.httpRequest': return [await this.http(node, items, runIndex)];
      default:
        if (hooks.types && hooks.types[node.type]) return norm(await hooks.types[node.type](items, this, node));
        throw new Error('runner: no implementation/hook for node ' + node.name + ' (' + node.type + ')');
    }
  }

  async code(node, items, runIndex) {
    const src = node.parameters.jsCode;
    const mode = node.parameters.mode || 'runOnceForAllItems';
    const base = this.exprCtx(items[0], runIndex, items);
    base.$getWorkflowStaticData = this.getStatic();
    base.console = { log() {}, warn() {}, error() {} };
    delete base.$fromAI;
    const names = Object.keys(base);
    if (mode === 'runOnceForEachItem') {
      const out = [];
      for (const item of items) {
        const ctx = Object.assign({}, base, { $json: item.json, $input: Object.assign({}, base.$input, { item }) });
        const fn = new AsyncFunction(...names, src);
        const r = await fn(...names.map((k) => ctx[k]));
        if (r == null) continue;
        out.push(r.json ? r : { json: r });
      }
      return out;
    }
    const fn = new AsyncFunction(...names, src);
    const r = await fn(...names.map((k) => base[k]));
    if (r == null) return [];
    if (!Array.isArray(r)) throw new Error('Code node ' + node.name + ' must return an array');
    return r.map((x) => (x && x.json ? x : { json: x }));
  }

  cond(c, ctx) {
    const l = this.evalExpr(c.leftValue, ctx);
    const r = this.evalExpr(c.rightValue, ctx);
    const op = c.operator || {};
    const strict = (t, v) => { if (typeof v !== t) throw new Error('Wrong type: ' + JSON.stringify(v) + ' is not a ' + t + ' [condition ' + (c.id || '') + ']'); };
    if (op.type === 'boolean') { strict('boolean', l); return op.operation === 'true' ? l === true : op.operation === 'false' ? l === false : l === r; }
    if (op.type === 'string') {
      const L = l == null ? '' : String(l), Rv = r == null ? '' : String(r);
      if (op.operation === 'equals') return L === Rv;
      if (op.operation === 'notEquals') return L !== Rv;
      if (op.operation === 'contains') return L.indexOf(Rv) >= 0;
    }
    throw new Error('runner: unsupported condition operator ' + JSON.stringify(op));
  }
  evalConditions(conds, ctx) {
    const list = conds.conditions || [];
    const res = list.map((c) => this.cond(c, ctx));
    return (conds.combinator || 'and') === 'and' ? res.every(Boolean) : res.some(Boolean);
  }
  ifNode(node, items, runIndex) {
    const p = node.parameters; const t = [], f = [];
    for (const item of items) {
      const ctx = this.exprCtx(item, runIndex, items);
      let pass;
      if (node.typeVersion >= 2) pass = this.evalConditions(p.conditions, ctx);
      else {
        const rows = (p.conditions && p.conditions.string) || [];
        pass = rows.every((row) => String(this.evalExpr(row.value1, ctx)) === String(this.evalExpr(row.value2, ctx)));
      }
      (pass ? t : f).push(item);
    }
    return [t, f];
  }
  switchNode(node, items, runIndex) {
    const rules = node.parameters.rules.values;
    const fb = node.parameters.options && node.parameters.options.fallbackOutput;
    const outs = []; for (let i = 0; i < this.mainOutputs(node); i++) outs.push([]);
    for (const item of items) {
      const ctx = this.exprCtx(item, runIndex, items);
      const idx = rules.findIndex((r) => this.evalConditions(r.conditions, ctx));
      if (idx >= 0) outs[idx].push(item);
      else if (typeof fb === 'number') outs[fb].push(item);
      else if (fb === 'extra') outs[rules.length].push(item);
    }
    return outs;
  }
  setNode(node, items, runIndex) {
    const p = node.parameters;
    return items.map((item) => {
      const ctx = this.exprCtx(item, runIndex, items);
      if (node.typeVersion >= 3) {
        const json = p.options && p.includeOtherFields ? Object.assign({}, item.json) : {};
        for (const a of (p.assignments && p.assignments.assignments) || []) json[a.name] = this.evalExpr(a.value, ctx);
        return { json };
      }
      const json = p.keepOnlySet ? {} : Object.assign({}, item.json);
      for (const a of (p.values && p.values.string) || []) json[a.name] = String(this.evalExpr(a.value, ctx));
      return { json };
    });
  }
  async http(node, items, runIndex) {
    const p = node.parameters;
    const out = [];
    for (const item of items) {
      const ctx = this.exprCtx(item, runIndex, items);
      const req = {
        node: node.name,
        method: String(this.evalExpr(p.method || 'GET', ctx) || 'GET').toUpperCase(),
        url: this.evalExpr(p.url, ctx),
        timeout: (p.options && p.options.timeout) || 300000,
        headers: {},
        body: undefined,
      };
      // Real n8n resolves displayOptions against the RAW parameter value: when a
      // toggle like sendBody/sendHeaders is an expression, the parameters it
      // reveals (jsonBody, jsonHeaders...) are treated as hidden and not sent.
      const literalTrue = (v) => v === true;
      if (literalTrue(p.sendHeaders) && p.specifyHeaders === 'json') req.headers = JSON.parse(this.evalExpr(p.jsonHeaders, ctx) || '{}');
      if (literalTrue(p.sendBody) && p.specifyBody === 'json') req.body = JSON.parse(this.evalExpr(p.jsonBody, ctx));
      const hook = this.env.hooks.http;
      if (!hook) throw new Error('runner: no http hook');
      const resp = await hook(req, this, item); // may throw (transport)
      const o = (p.options && p.options.response && p.options.response.response) || {};
      if (resp.binary) { out.push({ json: {}, binary: resp.binary }); continue; }
      if (!o.neverError && resp.statusCode >= 400) throw new Error('Request failed with status code ' + resp.statusCode);
      out.push({ json: o.fullResponse ? { body: resp.body, headers: resp.headers || {}, statusCode: resp.statusCode, statusMessage: '' } : resp.body });
    }
    return out;
  }
}
function norm(r) { if (!Array.isArray(r)) return [[r]]; if (r.length && !Array.isArray(r[0])) return [r]; return r; }
function copyItem(i) { const c = { json: JSON.parse(JSON.stringify(i.json)) }; if (i.binary) c.binary = i.binary; return c; }

module.exports = { Runner, KillSignal };
