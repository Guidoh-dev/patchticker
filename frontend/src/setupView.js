import {
  SETUP_DEVICES, SETUP_OS, SETUP_STORAGE_KEY, normalizeSetup, validateSetup,
  readSavedSetup, saveSetup, clearSavedSetup, setupLabel, graphicsVendor, updatesForSetup, assessUpdateForSetup,
} from './setupAdvisor.js';

const H = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const storage = kind => { try { return window[kind]; } catch { return null; } };
export const readBrowserSetup = () => readSavedSetup(storage('sessionStorage'), storage('localStorage'));
const remembered = () => { try { return Boolean(storage('localStorage')?.getItem(SETUP_STORAGE_KEY)); } catch { return false; } };
const sourceLink = url => { try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; } };
const displayDate = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Date unverified';

export function renderSetupWorkspace() {
  const saved = readBrowserSetup();
  const profile = normalizeSetup(saved || {});
  return `<section class="setup-workspace" id="section-overview" aria-labelledby="setup-title">
    <div class="setup-intro">
      <p class="setup-eyebrow"><span aria-hidden="true">◎</span> KNOW BEFORE YOU UPDATE</p>
      <h1 id="setup-title">Is this update good<br class="setup-title-break"> for <em>your setup?</em></h1>
      <p>Find the updates that fit your device. Check official hardware support, see the known issues, and understand what’s still unverified.</p>
      <a class="setup-browse-link" href="#/updates" data-scroll-target="section-latest">Just looking for patch notes? Browse all updates <span aria-hidden="true">↘</span></a>
      <div class="setup-trust"><span>Free to check</span><span>No account needed</span><span>Official sources linked</span></div>
    </div>
    <form class="setup-form" id="setup-check-form" data-clarity-mask="true">
      <div class="setup-form-head"><span>01 / YOUR DEVICE</span><small>Runs in your browser</small></div>
      <div class="setup-fields">
        <label class="setup-field" for="setup-device">What do you use?
          <select id="setup-device">${SETUP_DEVICES.map(([key, label]) => `<option value="${H(key)}"${profile.device === key ? ' selected' : ''}>${H(label)}</option>`).join('')}</select>
        </label>
        <label class="setup-field" id="setup-os-field" for="setup-os">Operating system
          <select id="setup-os">${SETUP_OS.map(([key, label]) => `<option value="${H(key)}"${profile.operatingSystem === key ? ' selected' : ''}>${H(label)}</option>`).join('')}</select>
        </label>
        <label class="setup-field setup-field--wide" id="setup-hardware-field" for="setup-hardware"><span id="setup-hardware-label">Your graphics card</span>
          <input id="setup-hardware" type="text" maxlength="120" autocomplete="off" placeholder="e.g. GeForce RTX 4070, Radeon RX 7800 XT" value="${H(profile.hardware)}" aria-describedby="setup-model-help" />
        </label>
      </div>
      <details class="setup-help" id="setup-model-guide"><summary>Find my model / add CPU details</summary><p id="setup-model-help">Windows: open Device Manager → Display adapters. Copy the full graphics model. For your Windows version, open Settings → System → About.</p><label class="setup-field" for="setup-cpu">CPU (optional · checks for named issue reports)<input id="setup-cpu" type="text" maxlength="120" placeholder="e.g. AMD Ryzen 7 7800X3D" value="${H(profile.cpu)}" autocomplete="off" /></label></details>
      <p class="setup-device-note" id="setup-device-note" hidden></p>
      <div class="setup-form-actions"><button class="btn btn--primary" id="setup-check-submit" type="submit" disabled>Loading official updates…</button><button class="btn btn--outline" id="setup-retry" type="button" hidden>Reconnect to official updates</button><label class="setup-remember"><input id="setup-remember" type="checkbox"${remembered() ? ' checked' : ''} /> Remember on this device</label></div>
      <p class="setup-error" id="setup-error" role="alert"></p>
      <p class="setup-limit">Checks published support and issues. It does not run a hardware benchmark or guarantee performance. Your hardware details stay in this browser.</p>
    </form>
  </section>
  <section class="setup-results" id="setup-results" aria-labelledby="setup-results-title" hidden data-clarity-mask="true"></section>`;
}

function assessmentCard(item, { logo, label }) {
  const { update, compatibility } = item;
  const issues = item.matchedIssues.length ? item.matchedIssues : item.issues;
  const url = sourceLink(item.sourceUrl);
  return `<article class="setup-result-card" data-result-status="${H(item.tone)}">
    <div class="setup-result-top">${logo(update.platform, 'setup-result-logo')}<span>${H(label(update.platform))}</span><span class="setup-source-score">${item.sourceScore === null ? 'Not scored' : `${H(item.sourceScore.toFixed(1))}/10 source score`}</span></div>
    <h3>${H(item.title)}</h3>
    <a class="setup-release-title" href="#/updates/${encodeURIComponent(update.id)}">${H(update.name)}</a>
    <p class="setup-result-date">${H(['artifact-published', 'catalog-updated', 'source-updated'].includes(update.dateBasis) ? 'Source dated' : 'Released')} ${H(displayDate(update.releasedAt))} · Source checked ${H(displayDate(update.lastCheckedAt))}</p>
    <dl class="setup-result-facts"><div><dt>Hardware support</dt><dd>${H(item.supportLabel || (compatibility.status === 'supported' ? compatibility.matchedLabel : compatibility.title || 'Model support unverified'))}</dd></div><div><dt>Known issues</dt><dd>${H(item.issueSummary)}</dd></div></dl>
    <p class="setup-result-reason">${H(item.scopeDetail || compatibility.detail || 'This release does not prove support for your exact model. Read the vendor’s requirements before installing.')}</p>
    ${issues.length ? `<details class="setup-issues"><summary>${item.matchedIssues.length ? 'Issues naming your hardware' : 'Review documented issues'} (${issues.length})</summary><ul>${issues.map(issue => `<li>${H(issue)}</li>`).join('')}</ul></details>` : ''}
    ${compatibility.guidance ? `<p class="setup-oem-note">${H(compatibility.guidance)}</p>` : ''}
    <div class="setup-result-actions"><a href="#/updates/${encodeURIComponent(update.id)}">Read full update <span aria-hidden="true">↗</span></a>${url ? `<a href="${H(url)}" target="_blank" rel="noopener noreferrer">Vendor source</a>` : ''}</div>
  </article>`;
}

function resultsMarkup(items, profile, renderers) {
  const supported = items.filter(item => item.compatibility.status === 'supported').length;
  const primary = items.filter(item => ['AMD', 'NVIDIA', 'Intel', 'Windows', 'macOS', 'Apple', 'PS5', 'Xbox', 'Switch', 'Switch2'].includes(item.update.platform) || item.update.sourceKind === 'steamos-news');
  const secondary = items.filter(item => !primary.includes(item));
  const hardwareScope = ['pc', 'mac'].includes(profile.device);
  return `<header class="setup-results-head"><div><p class="setup-eyebrow">02 / YOUR UPDATE CHECK</p><h2 id="setup-results-title">For ${H(setupLabel(profile))}</h2><p>${items.length} current release${items.length === 1 ? '' : 's'} in relevant product categories${hardwareScope ? ` · ${supported} with vendor-listed hardware support` : ' · use the device updater to confirm package eligibility'}</p></div><div><button class="link-btn" type="button" id="setup-edit">Edit setup</button><button class="link-btn" type="button" id="setup-forget">Clear setup</button></div></header>
    ${profile.device === 'pc' && !graphicsVendor(profile.hardware) ? '<p class="setup-stale">Graphics model not identified. These results cover general desktop software only. Enter the full graphics name to check a driver package.</p>' : ''}
    <p class="setup-stale" id="setup-stale" hidden>Setup changed. Run the check again to refresh these results.</p>
    <div class="setup-results-legend"><span><i data-status="supported"></i> Support listed</span><span><i data-status="caution"></i> Issues to review</span><span><i data-status="unverified"></i> More evidence needed</span></div>
    ${items.length ? `<div class="setup-results-grid">${primary.map(item => assessmentCard(item, renderers)).join('')}</div>${secondary.length ? `<details class="setup-related-releases"><summary>Browser and launcher releases (${secondary.length}) · installed apps vary</summary><div class="setup-results-grid">${secondary.map(item => assessmentCard(item, renderers)).join('')}</div></details>` : ''}` : '<div class="setup-empty"><h3>No current source-backed release matches yet.</h3><p>Try the full graphics model or search the update catalog below. A missing result does not establish compatibility.</p></div>'}
    <p class="setup-results-caveat">A vendor-listed model establishes package support. The source score summarizes the release notes; it does not predict frame rates, benchmark your device, or guarantee a trouble-free install.</p>`;
}

export function attachSetupWorkspace({ getUpdates, logo, label, onCheck = () => {}, onRetry = async () => {} }) {
  const form = document.getElementById('setup-check-form');
  if (!form) return { refresh() {} };
  const device = document.getElementById('setup-device');
  const input = document.getElementById('setup-hardware');
  const os = document.getElementById('setup-os');
  const resultNode = document.getElementById('setup-results');
  const submit = document.getElementById('setup-check-submit');
  const retry = document.getElementById('setup-retry');
  let applied = readBrowserSetup();
  let ready = false;
  const rawProfile = () => normalizeSetup({ device: device.value, hardware: input.value, operatingSystem: os.value, cpu: document.getElementById('setup-cpu').value });
  const scrollTo = node => node?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  function syncDevice() {
    const needsHardware = ['pc', 'mac'].includes(device.value);
    document.getElementById('setup-hardware-field').hidden = !needsHardware;
    document.getElementById('setup-os-field').hidden = device.value !== 'pc';
    input.required = needsHardware;
    input.disabled = !needsHardware;
    document.getElementById('setup-model-guide').hidden = !needsHardware;
    document.getElementById('setup-hardware-label').textContent = device.value === 'mac' ? 'Your Mac model + chip or year' : 'Your graphics card';
    input.placeholder = device.value === 'mac' ? 'e.g. MacBook Pro M4, MacBook Air 2020' : 'e.g. GeForce RTX 4070, Radeon RX 7800 XT';
    document.getElementById('setup-model-help').textContent = device.value === 'mac'
      ? 'Open Apple menu → About This Mac. Enter the model plus its year or chip, such as MacBook Pro M4.'
      : 'Windows: open Device Manager → Display adapters. Copy the full graphics model. For your Windows version, open Settings → System → About.';
    const note = document.getElementById('setup-device-note');
    note.hidden = needsHardware;
    note.textContent = 'We’ll show this device’s current update notes. Console and handheld updaters select the correct build; a component-level performance test is unavailable.';
  }
  function renderResults() {
    if (!applied || !ready) return;
    const items = updatesForSetup(getUpdates(), applied);
    resultNode.hidden = false;
    resultNode.innerHTML = resultsMarkup(items, applied, { logo, label });
    document.getElementById('setup-stale').hidden = JSON.stringify(rawProfile()) === JSON.stringify(applied);
    document.getElementById('setup-edit').addEventListener('click', () => { scrollTo(form); input.focus({ preventScroll: true }); });
    document.getElementById('setup-forget').addEventListener('click', () => {
      clearSavedSetup(storage('sessionStorage'), storage('localStorage'));
      applied = null; resultNode.hidden = true; resultNode.innerHTML = '';
      form.reset(); device.value = 'pc'; input.value = ''; os.value = 'not-sure';
      document.getElementById('setup-cpu').value = ''; document.getElementById('setup-remember').checked = false;
      syncDevice(); scrollTo(form); input.focus({ preventScroll: true });
    });
    return items;
  }
  form.addEventListener('input', () => { const stale = document.getElementById('setup-stale'); if (stale) stale.hidden = !applied || JSON.stringify(rawProfile()) === JSON.stringify(applied); });
  device.addEventListener('change', syncDevice);
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try { await onRetry(); } finally { if (retry.isConnected) retry.disabled = false; }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const profile = rawProfile();
    const error = validateSetup(profile);
    document.getElementById('setup-error').textContent = error;
    if (error || !ready) return;
    applied = profile;
    saveSetup(profile, document.getElementById('setup-remember').checked, storage('sessionStorage'), storage('localStorage'));
    const items = renderResults();
    onCheck({ result_count: items.length, has_results: items.length > 0 });
    scrollTo(resultNode);
  });
  syncDevice();
  return { refresh() {
    if (!form.isConnected) return;
    ready = getUpdates().length > 0;
    submit.disabled = !ready;
    submit.textContent = ready ? 'Check my setup →' : 'Updates unavailable · try again shortly';
    retry.hidden = ready;
    renderResults();
  } };
}

export function renderSetupDetail(update) {
  const profile = readBrowserSetup();
  if (!profile) return '';
  const item = assessUpdateForSetup(update, profile);
  return `<section class="setup-detail-context" data-result-status="${H(item.tone)}" data-clarity-mask="true"><div><span>YOUR SETUP · ${H(setupLabel(profile))}</span><strong>${H(item.title)}</strong><p>${H(item.scopeDetail || item.compatibility.detail || 'The available vendor evidence does not establish model-level support. Check the full requirements below.')}</p></div><a href="#/updates">Back to my setup →</a></section>`;
}
