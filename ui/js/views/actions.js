// Per-repository GitHub Actions: runs, run detail with jobs/steps/logs, re-run, cancel, dispatch, deployments.
import { h, mount, icon, btn, iconBtn, act, form, banner, ago, duration, statusBadge, runDot, confirmDanger, copyText, debounce } from '../dom.js';
import { rpc } from '../api.js';
import { store, subscribe, boardFor } from '../store.js';
import { navigate } from '../router.js';
import { unavailable } from './prs.js';

export function render(view, r, sub) {
  if (!r.slug || !r.slug.github) return unavailable(view, r, 'GitHub Actions');
  const m = /^run$/.test(sub || '') ? location.hash.split('/').pop() : null;
  if (m && /^\d+$/.test(m)) return runDetail(view, r, +m);
  return runList(view, r);
}

function runList(view, r) {
  let workflows = [];
  const f = { workflow: '', branch: '', status: '' };
  const bar = h('div', { class: 'diff-toolbar' });
  const head = h('div');
  const body = h('div', { class: 'pane-scroll' });
  mount(view, h('div', { class: 'pane', style: { flex: 1 } }, bar, h('div', { class: 'pane-scroll' }, head, body)));
  const branchIn = h('input', { type: 'search', placeholder: 'Branch', style: { width: '150px' } });
  branchIn.addEventListener('input', debounce(() => { f.branch = branchIn.value.trim(); load(); }, 400));
  function renderBar() {
    mount(bar,
      h('select', { onchange: (e) => { f.workflow = e.target.value; load(); } }, h('option', { value: '' }, 'All workflows'), workflows.map((w) => h('option', { value: String(w.id), selected: String(w.id) === f.workflow }, `${w.name}${w.state !== 'active' ? ` (${w.state})` : ''}`))),
      branchIn,
      h('select', { onchange: (e) => { f.status = e.target.value; load(); } }, [['', 'Any status'], ['failure', 'Failed'], ['in_progress', 'In progress'], ['queued', 'Queued'], ['success', 'Succeeded'], ['cancelled', 'Cancelled']].map(([v, l]) => h('option', { value: v, selected: f.status === v }, l))),
      h('span', { class: 'spacer' }),
      iconBtn('refresh', 'Refresh', () => load()),
      btn('Run workflow…', () => dispatchDialog(r, workflows), { cls: 'small', iconName: 'play' }),
      btn('Actions on GitHub', () => rpc('open.url', { url: `https://github.com/${r.slug.owner}/${r.slug.repo}/actions` }), { cls: 'small', iconName: 'external' }));
  }
  function renderHead() {
    const b = boardFor(r);
    const trackers = store.trackers.filter((t) => t.repoId === r.id && (t.state === 'waiting' || t.state === 'running'));
    const envBox = h('div');
    mount(head, h('div', { class: 'page', style: { paddingBottom: 0 } },
      trackers.length ? h('div', { class: 'info-box', style: { marginBottom: '10px' } }, `Tracking ${trackers.length} run set(s) started from this app. `, h('a', { onclick: () => navigate('#/board') }, 'Open the Actions board')) : null,
      b && !b.error ? h('div', { class: 'panel', style: { marginBottom: '12px' } },
        h('div', { class: 'panel-head' }, h('h3', { class: 'grow' }, `Latest on ${b.branch}`), h('span', { class: 'muted ellipsis', style: { maxWidth: '50%' } }, `${(b.oid || '').slice(0, 8)} ${b.headline || ''}`), h('span', { class: 'faint' }, b.committedDate ? ago(b.committedDate) : '')),
        b.runs.length ? b.runs.map((x) => h('div', { class: 'run-row', onclick: () => navigate(`#/repo/${r.id}/actions/run/${x.id}`) }, statusBadge(x.status, x.conclusion), h('span', { class: 'grow' }, x.workflow), h('span', { class: 'faint' }, x.status === 'completed' ? duration(x.createdAt, x.updatedAt) : `running ${duration(x.createdAt)}`)))
          : h('div', { class: 'panel-body muted' }, 'No workflow runs for the latest commit.')) : b && b.error ? h('div', { class: 'warn-box', style: { marginBottom: '12px' } }, b.error.split('\n')[0]) : null,
      envBox));
    rpc('deploy.list', { id: r.id }).then((d) => {
      if (!d.latest.length) return;
      mount(envBox, h('div', { class: 'panel', style: { marginBottom: '12px' } }, h('div', { class: 'panel-head' }, h('h3', null, 'Environments')),
        d.latest.map((dep) => h('div', { class: 'run-row', onclick: () => dep.latestStatus && dep.latestStatus.logUrl && rpc('open.url', { url: dep.latestStatus.logUrl }) },
          h('span', { class: `badge ${(dep.latestStatus || {}).state === 'SUCCESS' ? 'ok' : ['FAILURE', 'ERROR'].includes((dep.latestStatus || {}).state) ? 'bad' : 'run'}` }, ((dep.latestStatus || {}).state || dep.state || '').toLowerCase()),
          h('strong', null, dep.environment), h('span', { class: 'muted grow' }, `${dep.ref ? dep.ref.name : ''} @ ${(dep.commitOid || '').slice(0, 8)}`),
          dep.latestStatus && dep.latestStatus.environmentUrl ? h('a', { onclick: (e) => { e.stopPropagation(); rpc('open.url', { url: dep.latestStatus.environmentUrl }); } }, 'open site') : null,
          h('span', { class: 'faint' }, ago((dep.latestStatus || dep).createdAt))))));
    }).catch(() => {});
  }
  async function load() {
    mount(body, h('div', { class: 'progress' }));
    try {
      const runs = await rpc('run.list', { id: r.id, workflow: f.workflow || undefined, branch: f.branch || undefined, status: f.status || undefined, limit: 50 });
      mount(body, h('div', { class: 'page', style: { paddingTop: 0 } }, h('h3', { style: { margin: '6px 0 8px' } }, 'Recent runs'),
        runs.length ? h('div', { class: 'panel' }, runs.map((x) => h('div', { class: 'run-row', onclick: () => navigate(`#/repo/${r.id}/actions/run/${x.databaseId}`) },
          statusBadge(x.status, x.conclusion),
          h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'ellipsis' }, x.displayTitle), h('div', { class: 'sub' }, `${x.workflowName} #${x.number} · ${x.event} · ${x.headBranch} · ${x.headSha.slice(0, 7)}${x.attempt > 1 ? ` · attempt ${x.attempt}` : ''}`)),
          h('span', { class: 'faint', style: { whiteSpace: 'nowrap' } }, x.status === 'completed' ? duration(x.startedAt || x.createdAt, x.updatedAt) : duration(x.startedAt || x.createdAt)),
          h('span', { class: 'faint', style: { width: '80px', textAlign: 'right' } }, ago(x.createdAt)))))
          : h('div', { class: 'empty' }, 'No runs match.')));
    } catch (e) { mount(body, h('div', { class: 'errbox', style: { margin: '12px' } }, e.message)); }
  }
  rpc('workflow.list', { id: r.id }).then((w) => { workflows = w; renderBar(); }).catch(() => {});
  renderBar(); renderHead(); load();
  const unsub = [subscribe('board', renderHead), subscribe('trackers', renderHead)];
  const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30_000);
  return { dispose() { unsub.forEach((u) => u()); clearInterval(timer); } };
}

async function dispatchDialog(r, workflows) {
  const all = workflows.length ? workflows : await rpc('workflow.list', { id: r.id }).catch(() => []);
  const active = all.filter((w) => w.state === 'active');
  if (!active.length) { banner({ level: 'info', title: 'No active workflows', timeout: 3000 }); return; }
  const s = r.summary || {};
  const pick = await form({ title: 'Run workflow', fields: [
    { name: 'wf', label: 'Workflow', type: 'select', options: active.map((w) => ({ value: String(w.id), label: `${w.name} (${w.path.split('/').pop()})` })) },
    { name: 'ref', label: 'Branch or tag', value: s.defaultBranch || s.branch || 'main', required: true },
  ], submit: 'Next' });
  if (!pick) return;
  let info;
  try { info = await rpc('workflow.inputs', { id: r.id, workflowId: pick.wf, ref: pick.ref }); } catch (e) { banner({ level: 'error', title: 'Could not read the workflow file', body: e.message }); return; }
  if (!info.hasDispatch) { banner({ level: 'warn', title: 'This workflow cannot be started manually', body: 'It has no "workflow_dispatch" trigger.', timeout: 6000 }); return; }
  const fields = info.inputs.map((i) => (i.type === 'boolean' ? { name: i.name, label: `${i.name}${i.description ? ` — ${i.description}` : ''}`, type: 'checkbox', value: i.default === 'true' }
    : i.type === 'choice' && i.options.length ? { name: i.name, label: `${i.name}${i.description ? ` — ${i.description}` : ''}`, type: 'select', options: i.options, value: i.default || i.options[0] }
      : { name: i.name, label: `${i.name}${i.required ? ' *' : ''}${i.description ? ` — ${i.description}` : ''}`, value: i.default, required: i.required }));
  const wf = active.find((w) => String(w.id) === pick.wf);
  const v = fields.length ? await form({ title: `Run ${wf.name} on ${pick.ref}`, fields, submit: 'Run workflow' }) : await confirmDanger({ title: `Run ${wf.name}?`, message: `Start "${wf.name}" on ${pick.ref}. It has no inputs.`, confirmLabel: 'Run workflow', danger: false });
  if (!v) return;
  const inputs = fields.length ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'boolean' ? String(x) : x])) : {};
  act(() => rpc('workflow.dispatch', { id: r.id, workflowId: pick.wf, ref: pick.ref, inputs }), { ok: 'Workflow started; it will be tracked on the Actions board' });
}

function runDetail(view, r, runId) {
  let run = null;
  let disposed = false;
  let timer = null;
  let selectedJob = null;
  const head = h('div', { class: 'repo-head' });
  const jobsEl = h('div', { class: 'pane-scroll', style: { width: '340px', flex: 'none', borderRight: '1px solid var(--border)', background: 'var(--panel)' } });
  const logBar = h('div', { class: 'diff-toolbar' });
  const logEl = h('div', { class: 'log' });
  mount(view, h('div', { class: 'pane', style: { flex: 1 } }, head, h('div', { class: 'split' }, jobsEl, h('div', { class: 'right' }, logBar, logEl))));

  async function load() {
    try { run = await rpc('run.view', { id: r.id, runId }); } catch (e) { mount(logEl, e.message); return; }
    if (disposed) return;
    const failed = ['failure', 'timed_out', 'cancelled', 'startup_failure'].includes(run.conclusion);
    const tracked = store.trackers.some((t) => (t.runId === runId || t.runs.some((x) => x.id === runId)) && t.state !== 'done');
    mount(head,
      iconBtn('back', 'Back to runs', () => navigate(`#/repo/${r.id}/actions`)),
      statusBadge(run.status, run.conclusion),
      h('div', { class: 'col grow', style: { gap: '0' } }, h('span', { class: 'title ellipsis' }, run.displayTitle),
        h('span', { class: 'muted', style: { fontSize: '12px' } }, `${run.workflowName} #${run.number} · ${run.event} · ${run.headBranch} · ${run.headSha.slice(0, 8)} · ${run.status === 'completed' ? `took ${duration(run.startedAt || run.createdAt, run.updatedAt)}` : `running for ${duration(run.startedAt || run.createdAt)}`}${run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}`)),
      run.status !== 'completed' && !tracked ? btn('Notify me when done', () => act(() => rpc('run.track', { id: r.id, runId, title: `${run.workflowName}: ${run.displayTitle}` }), { ok: 'Tracking this run' }), { cls: 'small', iconName: 'bell' }) : null,
      run.status !== 'completed' ? btn('Cancel run', async () => { if (await confirmDanger({ title: 'Cancel run?', message: 'Stops the run. Jobs already finished keep their results.', confirmLabel: 'Cancel run' })) act(() => rpc('run.cancel', { id: r.id, runId }), { ok: 'Cancel requested' }).then(load); }, { cls: 'small danger' }) : null,
      run.status === 'completed' && failed ? btn('Re-run failed jobs', () => act(() => rpc('run.rerun', { id: r.id, runId, failed: true, title: run.workflowName }), { ok: 'Re-running failed jobs' }).then(load), { cls: 'small primary' }) : null,
      run.status === 'completed' ? btn('Re-run all', () => act(() => rpc('run.rerun', { id: r.id, runId, title: run.workflowName }), { ok: 'Re-running all jobs' }).then(load), { cls: 'small' }) : null,
      btn('GitHub', () => rpc('open.url', { url: run.url }), { cls: 'small', iconName: 'external' }));
    const jobs = run.jobs || [];
    if (!selectedJob) { const fj = jobs.find((j) => ['failure', 'timed_out', 'cancelled'].includes(j.conclusion)) || jobs[0]; selectedJob = fj ? fj.databaseId : null; }
    mount(jobsEl, jobs.length ? jobs.map((j) => h('div', null,
      h('div', { class: `list-row ${selectedJob === j.databaseId ? 'selected' : ''}`, onclick: () => { selectedJob = j.databaseId; load(); } },
        runDot(j.status, j.conclusion), h('div', { class: 'grow' }, h('div', { class: 't ellipsis' }, j.name), h('div', { class: 'sub' }, j.startedAt ? (j.completedAt && j.status === 'completed' ? duration(j.startedAt, j.completedAt) : `running ${duration(j.startedAt)}`) : 'waiting'))),
      selectedJob === j.databaseId ? h('div', { class: 'run-steps' }, (j.steps || []).map((s) => h('div', { class: 'run-step' }, runDot(s.status, s.conclusion), h('span', { class: 'grow' }, s.name),
        h('span', { class: 'faint' }, s.startedAt && s.completedAt && s.status === 'completed' ? duration(s.startedAt, s.completedAt) : '')))) : null))
      : h('div', { class: 'empty' }, run.status === 'completed' ? 'No jobs.' : 'Waiting for jobs to start…'));
    loadLog(jobs.find((j) => j.databaseId === selectedJob));
    clearTimeout(timer);
    if (run.status !== 'completed') timer = setTimeout(load, 8000);
  }

  let lastLogJob = null; let lastLogDone = false;
  async function loadLog(job) {
    if (!job) { mount(logBar); logEl.textContent = ''; return; }
    if (lastLogJob === job.databaseId && lastLogDone) return;
    const done = job.status === 'completed';
    if (!done) { mount(logBar, h('span', { class: 'muted' }, 'Logs are available when the job finishes.'), h('span', { class: 'spacer' }), btn('Open live log on GitHub', () => rpc('open.url', { url: job.url }), { cls: 'small' })); logEl.textContent = ''; return; }
    lastLogJob = job.databaseId; lastLogDone = true;
    mount(logBar, h('span', { class: 'muted' }, 'Loading log…'));
    let text;
    try { text = (await rpc('run.log', { id: r.id, runId, jobId: job.databaseId })).text; } catch (e) { lastLogDone = false; mount(logBar, h('span', { style: { color: 'var(--bad)' } }, e.message.split('\n')[0])); return; }
    if (disposed) return;
    const lines = text.split('\n').map((l) => {
      const parts = l.split('\t');
      const content = parts.length >= 3 ? parts.slice(2).join('\t') : l;
      const step = parts.length >= 3 && parts[1] !== 'UNKNOWN STEP' ? parts[1] : '';
      // eslint-disable-next-line no-control-regex
      return { step, text: content.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') };
    });
    const errIdx = [];
    lines.forEach((l, i) => { if (/##\[error\]|^Error[: ]|\bERROR\b|FAILED|Traceback|npm ERR!|error TS\d+|AssertionError|exit code [1-9]/.test(l.text)) errIdx.push(i); });
    const frag = document.createDocumentFragment();
    if (errIdx.length) {
      // The failing lines with a little context, in their own box, before the full log.
      const shown = new Set();
      for (const i of errIdx.slice(0, 40)) for (let k = Math.max(0, i - 4); k <= Math.min(lines.length - 1, i + 2); k++) shown.add(k);
      const bodyEl = h('div', { class: 'fb-body' });
      let prev = -2;
      for (const k of [...shown].sort((p, q) => p - q)) {
        if (k !== prev + 1 && prev !== -2) bodyEl.append(h('span', { class: 'faint' }, '   …\n'));
        bodyEl.append(errIdx.includes(k) ? h('span', { class: 'err' }, lines[k].text.replace(/##\[error\]/, '')) : `${lines[k].text}\n`);
        prev = k;
      }
      const failedStep = (job.steps || []).find((st) => st.conclusion === 'failure');
      frag.append(h('div', { class: 'fail-box' }, h('div', { class: 'fb-head' }, 'What failed', h('span', { class: 'spacer' }), h('span', { style: { fontWeight: 400 } }, failedStep ? failedStep.name : `${errIdx.length} error line(s)`)), bodyEl),
        h('div', { class: 'eyebrow', style: { padding: '0 16px 6px', fontFamily: 'var(--font)' } }, `Full log · ${lines.length} lines`));
    }
    let step = null;
    for (const [i, l] of lines.entries()) {
      if (l.step !== step) { step = l.step; if (step) frag.append(h('span', { class: 'grp' }, `▸ ${step}`)); }
      if (/^##\[group\]/.test(l.text)) { frag.append(h('span', { class: 'grp', style: { fontWeight: 400 } }, l.text.replace('##[group]', ''))); continue; }
      if (/^##\[endgroup\]/.test(l.text)) continue;
      frag.append(errIdx.includes(i) ? h('span', { class: 'err' }, l.text.replace(/##\[error\]/, '')) : `${l.text}\n`);
    }
    logEl.textContent = '';
    logEl.append(frag);
    mount(logBar, h('strong', null, job.name), errIdx.length ? h('span', { class: 'badge bad' }, `${errIdx.length} error line(s)`) : null, h('span', { class: 'spacer' }),
      btn('Copy log', () => copyText(text), { cls: 'small', iconName: 'copy' }),
      btn('Save log…', () => { const a = h('a', { download: `${run.workflowName}-${job.name}-${runId}.log`.replace(/[^\w.-]+/g, '_') }); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }, { cls: 'small' }),
      btn('Open on GitHub', () => rpc('open.url', { url: job.url }), { cls: 'small', iconName: 'external' }));
  }

  load();
  return { dispose() { disposed = true; clearTimeout(timer); } };
}

export { icon };
