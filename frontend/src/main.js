// src/main.js
// ─────────────────────────────────────────────────────────────────────────────
// PatchTicker — SaaS frontend entry point
//
// VIEWS
//  login, register, forgot-password, reset-password, verify-email,
//  pricing, dashboard (authenticated, role-aware)
//
// CSP COMPLIANCE: no inline styles, no inline handlers, no eval
// ─────────────────────────────────────────────────────────────────────────────

import {
  register as apiRegister, login as apiLogin, logout as apiLogout,
  getMe, verifyEmail as apiVerifyEmail, resendVerification,
  forgotPassword as apiForgotPassword, resetPassword as apiResetPassword,
  createCheckout, openBillingPortal, getBillingStatus,
  fetchUpdates, fetchSummary, submitBugReport,
  fetchUpdateById, fetchRecentPosts, submitPost, openFeedStream,
} from './api.js';
import { restoreSession, setUser, signOut, getUser, isLoggedIn, hasRole, onAuthChange } from './auth.js';
import { route, navigate, start, queryParams } from './router.js';

// ── Ad system ─────────────────────────────────────────────────────────────────
//
// CONDITIONAL LOADING GUARANTEE
// ───────────────────────────────
// The AdSense script is never present in index.html. It is only injected into
// the DOM after session restore confirms the user is free tier. Premium users
// (pro, admin) never trigger a request to googlesyndication.com — the script
// tag is never created for them, not just hidden.
//
// FLOW
//   1. App boots → restoreSession() resolves with user object
//   2. shouldShowAds() checks user.role === 'free'
//   3. If true  → loadAdScript() injects <script> tag once, sets _adScriptLoaded
//   4. If false → nothing. No network request. No DOM node. No cookies from Google.
//
// Role hierarchy:  free < pro < admin
// Any role above 'free' gets no ads and no ad script.

const HCAPTCHA_SITE_KEY = typeof __HCAPTCHA_SITE_KEY__ !== 'undefined' ? __HCAPTCHA_SITE_KEY__ : '';
const ADSENSE_PUBLISHER_ID = 'ca-pub-5058946458366067';
let _adScriptLoaded = false;  // guard: only inject the script tag once per session

/**
 * Returns true only for authenticated free-tier users.
 * Logged-out visitors and any paid role return false.
 */
function shouldShowAds() {
  const user = getUser();
  if (!user) return false;
  return user.role === 'free';
}

/**
 * Dynamically load the AdSense script — called once when a free-tier user
 * is confirmed. Safe to call multiple times; subsequent calls are no-ops.
 *
 * The script is injected with async so it never blocks rendering.
 * Returns a Promise that resolves when the script loads (or rejects on error).
 *
 * @returns {Promise<void>}
 */
function loadAdScript() {
  return new Promise((resolve, reject) => {
    // Already loaded this session — no-op
    if (_adScriptLoaded || document.getElementById('adsense-script')) {
      _adScriptLoaded = true;
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.id          = 'adsense-script';
    script.async       = true;
    script.crossOrigin = 'anonymous';
    script.src         = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER_ID}`;

    script.onload = () => {
      _adScriptLoaded = true;
      resolve();
    };
    script.onerror = () => {
      // Ad blocker or network failure — fail silently, never break the app
      console.warn('[ads] AdSense script failed to load (ad blocker?)');
      resolve(); // resolve, not reject — ad failure is non-fatal
    };

    document.head.appendChild(script);
  });
}

/**
 * Inject an AdSense ad unit into a container element.
 *
 * Loads the AdSense script on first call (for free users only), then renders
 * the <ins> unit. Safe to call on every render — skips if already injected,
 * user is not free tier, or AdSense failed to load.
 *
 * @param {string} containerId  — id of the host <div>
 * @param {string} adSlot       — AdSense ad unit slot ID, or 'auto' for Auto ads
 */
async function injectAd(containerId, adSlot = 'auto') {
  // Hard gate — premium users never reach loadAdScript()
  if (!shouldShowAds()) return;

  // Load the script on first call; subsequent calls skip the network request
  await loadAdScript();

  const container = document.getElementById(containerId);
  if (!container || container.dataset.adInjected) return;

  // Mark immediately to prevent double-injection on rapid re-renders
  container.dataset.adInjected = 'true';

  const ins = document.createElement('ins');
  ins.className                  = 'adsbygoogle';
  ins.style.display              = 'block';
  ins.dataset.adClient           = ADSENSE_PUBLISHER_ID;
  ins.dataset.adSlot             = adSlot;
  ins.dataset.adFormat           = 'auto';
  ins.dataset.fullWidthResponsive = 'true';
  container.appendChild(ins);

  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch (e) {
    console.warn('[ads] adsbygoogle.push failed:', e.message);
  }
}

/**
 * Remove all injected ad units and unload the AdSense script.
 * Called when a free user upgrades to Pro within the same session —
 * immediately removes ads without requiring a page reload.
 */
function unloadAds() {
  // Remove all <ins> ad units from the DOM
  document.querySelectorAll('ins.adsbygoogle').forEach(el => el.remove());

  // Remove the script tag so it won't reload on next navigation
  const script = document.getElementById('adsense-script');
  if (script) script.remove();

  // Clear the adsbygoogle queue so push() calls are no-ops
  window.adsbygoogle = [];
  _adScriptLoaded = false;
}

const app = document.getElementById('app');

// ── HTML escape ───────────────────────────────────────────────────────────────
const H = (s) => String(s).replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;' }[c])
);

// ── Render helpers ────────────────────────────────────────────────────────────
function setHTML(html) { app.innerHTML = html; }

function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--visible'));
  setTimeout(() => {
    t.classList.remove('toast--visible');
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

function spinner() {
  return '<div class="spinner"></div>';
}

// ── Nav bar ───────────────────────────────────────────────────────────────────
function renderNav(user) {
  const roleLabel = user?.role ? `<span class="nav-role nav-role--${user.role}">${user.role.toUpperCase()}</span>` : '';
  const userEmail = user ? `<span class="nav-email">${H(user.email)}</span>` : '';
  const rightLinks = user
    ? `${roleLabel}${userEmail}<a class="nav-btn" href="#/account">Account</a><button class="nav-btn" id="nav-logout">Sign out</button>`
    : `<a class="nav-link" href="#/login">Sign in</a><a class="nav-btn nav-btn--primary" href="#/register">Get started</a>`;

  const adminLink = user?.role === 'admin' ? `<a class="nav-link nav-link--admin" href="#/admin">Admin</a>` : '';

  return `
    <nav class="nav">
      <a class="nav-brand" href="#/">
        <span class="brand-pulse">Patch</span>Ticker
      </a>
      <div class="nav-right">
        ${user ? `<a class="nav-link" href="#/updates">Updates</a><a class="nav-link" href="#/pricing">Pricing</a>${adminLink}` : `<a class="nav-link" href="#/updates">Updates</a><a class="nav-link" href="#/pricing">Pricing</a>`}
        ${rightLinks}
      </div>
    </nav>
  `;
}

function attachNavHandlers(user) {
  const logoutBtn = document.getElementById('nav-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await apiLogout();
      signOut();
      navigate('/login');
    });
  }
}

// ── Loading screen ────────────────────────────────────────────────────────────
function renderLoading() {
  setHTML(`
    <div class="loading-screen">
      <div class="loading-logo"><span class="brand-pulse">Patch</span>Ticker</div>
      <div class="loading-text">Initialising session...</div>
    </div>
  `);
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
function renderLogin() {
  const user = getUser();
  setHTML(`
    ${renderNav(null)}
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo"><span class="brand-pulse">Patch</span>Ticker</div>
          <h1 class="auth-title">Sign in to PatchTicker</h1>
          <p class="auth-subtitle">Track software updates. Catch regressions early.</p>
        </div>
        <form class="auth-form" id="login-form" novalidate>
          <div class="field-group">
            <label class="field-label" for="login-email">Email address</label>
            <input class="field-input" id="login-email" type="email" autocomplete="email" placeholder="you@example.com" required />
          </div>
          <div class="field-group">
            <label class="field-label" for="login-password">
              Password
              <a class="field-link" href="#/forgot-password">Forgot password?</a>
            </label>
            <input class="field-input" id="login-password" type="password" autocomplete="current-password" placeholder="••••••••" required />
          </div>
          <div class="auth-error hidden" id="login-error"></div>
          <button class="btn btn--primary btn--full" type="submit" id="login-submit">Sign in</button>
        </form>
        <p class="auth-footer">
          No account? <a class="auth-link" href="#/register">Create one free</a>
        </p>
      </div>
    </div>
  `);
  attachNavHandlers(null);

  const form     = document.getElementById('login-form');
  const errorEl  = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    try {
      const email    = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const data     = await apiLogin({ email, password });
      setUser(data.user);
      showToast('Welcome back!', 'success');
      navigate('/updates');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });
}

// ── REGISTER ──────────────────────────────────────────────────────────────────
function renderRegister() {
  setHTML(`
    ${renderNav(null)}
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo"><span class="brand-pulse">Patch</span>Ticker</div>
          <h1 class="auth-title">Create your account</h1>
          <p class="auth-subtitle">Free forever. Upgrade for real-time alerts and API access.</p>
        </div>
        <form class="auth-form" id="register-form" novalidate>
          <div class="field-group">
            <label class="field-label" for="reg-email">Email address</label>
            <input class="field-input" id="reg-email" type="email" autocomplete="email" placeholder="you@example.com" required />
          </div>
          <div class="field-group">
            <label class="field-label" for="reg-password">Password</label>
            <input class="field-input" id="reg-password" type="password" autocomplete="new-password" placeholder="Min 8 chars" required />
            <div class="password-strength" id="pwd-strength"></div>
          </div>
          <!-- hCaptcha widget — rendered here, token collected on submit -->
          <div class="field-group">
            <div class="h-captcha"
                 id="hcaptcha-widget"
                 data-sitekey="${H(HCAPTCHA_SITE_KEY)}"
                 data-theme="dark"
                 data-size="normal">
            </div>
          </div>
          <div class="auth-error hidden" id="reg-error"></div>
          <button class="btn btn--primary btn--full" type="submit" id="reg-submit">Create account</button>
        </form>
        <p class="auth-footer">
          Already have an account? <a class="auth-link" href="#/login">Sign in</a>
        </p>
      </div>
    </div>
  `);
  attachNavHandlers(null);

  const form      = document.getElementById('register-form');
  const errorEl   = document.getElementById('reg-error');
  const submitBtn = document.getElementById('reg-submit');
  const pwdInput  = document.getElementById('reg-password');
  const strength  = document.getElementById('pwd-strength');

  // Render hCaptcha widget once the hcaptcha global is available.
  // The async script tag in index.html sets window.hcaptcha when ready.
  let captchaWidgetId = null;
  function mountCaptcha() {
    if (!HCAPTCHA_SITE_KEY) {
      errorEl.textContent = 'CAPTCHA is not configured. Add VITE_HCAPTCHA_SITE_KEY before enabling registration.';
      errorEl.classList.remove('hidden');
      submitBtn.disabled = true;
      return;
    }
    if (typeof window.hcaptcha !== 'undefined' && captchaWidgetId === null) {
      captchaWidgetId = window.hcaptcha.render('hcaptcha-widget', {
        sitekey: HCAPTCHA_SITE_KEY,
        theme:   'dark',
        size:    'normal',
      });
    }
  }
  // Try immediately (script may already be loaded on second visit to page)
  mountCaptcha();
  // Also hook the hCaptcha onload callback in case script hasn't fired yet
  const _prevOnload = window.onloadCallback;
  window.onloadCallback = () => { mountCaptcha(); if (_prevOnload) _prevOnload(); };

  pwdInput.addEventListener('input', () => {
    const v = pwdInput.value;
    let score = 0;
    if (v.length >= 8)  score++;
    if (v.length >= 12) score++;
    if (/[A-Z]/.test(v)) score++;
    if (/[0-9]/.test(v)) score++;
    if (/[^A-Za-z0-9]/.test(v)) score++;
    const labels = ['', 'Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
    const classes = ['', 'weak', 'weak', 'fair', 'strong', 'strong'];
    strength.textContent = v ? labels[score] || 'Weak' : '';
    strength.className = `password-strength strength--${classes[score] || 'weak'}`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account…';

    try {
      const email    = document.getElementById('reg-email').value.trim();
      const password = document.getElementById('reg-password').value;

      // Collect the hCaptcha response token.
      // getResponse() returns '' if the user hasn't completed the challenge.
      let captchaToken = '';
      if (typeof window.hcaptcha !== 'undefined' && captchaWidgetId !== null) {
        captchaToken = window.hcaptcha.getResponse(captchaWidgetId);
      }
      if (!captchaToken) {
        throw new Error('Please complete the CAPTCHA challenge before continuing.');
      }

      const data = await apiRegister({ email, password, 'h-captcha-response': captchaToken });
      setUser(data.user);
      showToast('Account created! Check your email to verify.', 'success');
      navigate('/updates');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
      // Reset captcha so user can attempt again with a fresh token
      if (typeof window.hcaptcha !== 'undefined' && captchaWidgetId !== null) {
        window.hcaptcha.reset(captchaWidgetId);
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
    }
  });
}

// ── FORGOT PASSWORD ───────────────────────────────────────────────────────────
function renderForgotPassword() {
  setHTML(`
    ${renderNav(null)}
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo"><span class="brand-pulse">Patch</span>Ticker</div>
          <h1 class="auth-title">Forgot your password?</h1>
          <p class="auth-subtitle">We'll send a reset link to your email.</p>
        </div>
        <form class="auth-form" id="forgot-form" novalidate>
          <div class="field-group">
            <label class="field-label" for="forgot-email">Email address</label>
            <input class="field-input" id="forgot-email" type="email" autocomplete="email" placeholder="you@example.com" required />
          </div>
          <div class="auth-error hidden" id="forgot-error"></div>
          <div class="auth-success hidden" id="forgot-success"></div>
          <button class="btn btn--primary btn--full" type="submit" id="forgot-submit">Send reset link</button>
        </form>
        <p class="auth-footer"><a class="auth-link" href="#/login">← Back to sign in</a></p>
      </div>
    </div>
  `);

  const form      = document.getElementById('forgot-form');
  const errorEl   = document.getElementById('forgot-error');
  const successEl = document.getElementById('forgot-success');
  const submitBtn = document.getElementById('forgot-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    try {
      const email = document.getElementById('forgot-email').value.trim();
      const data  = await apiForgotPassword(email);
      successEl.textContent = data.message;
      successEl.classList.remove('hidden');
      form.reset();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send reset link';
    }
  });
}

// ── RESET PASSWORD ────────────────────────────────────────────────────────────
function renderResetPassword(params) {
  const token = params.token || '';
  setHTML(`
    ${renderNav(null)}
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo"><span class="brand-pulse">Patch</span>Ticker</div>
          <h1 class="auth-title">Set new password</h1>
          <p class="auth-subtitle">Choose a strong password for your account.</p>
        </div>
        ${!token ? '<p class="auth-error">Invalid reset link. Please request a new one.</p>' : `
        <form class="auth-form" id="reset-form" novalidate>
          <div class="field-group">
            <label class="field-label" for="reset-password">New password</label>
            <input class="field-input" id="reset-password" type="password" autocomplete="new-password" placeholder="Min 8 chars" required />
          </div>
          <div class="field-group">
            <label class="field-label" for="reset-confirm">Confirm new password</label>
            <input class="field-input" id="reset-confirm" type="password" autocomplete="new-password" placeholder="Repeat password" required />
          </div>
          <div class="auth-error hidden" id="reset-error"></div>
          <div class="auth-success hidden" id="reset-success"></div>
          <button class="btn btn--primary btn--full" type="submit" id="reset-submit">Update password</button>
        </form>`}
        <p class="auth-footer"><a class="auth-link" href="#/login">← Back to sign in</a></p>
      </div>
    </div>
  `);

  if (!token) return;

  const form      = document.getElementById('reset-form');
  const errorEl   = document.getElementById('reset-error');
  const successEl = document.getElementById('reset-success');
  const submitBtn = document.getElementById('reset-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const password        = document.getElementById('reset-password').value;
    const confirmPassword = document.getElementById('reset-confirm').value;

    if (password !== confirmPassword) {
      errorEl.textContent = 'Passwords do not match';
      errorEl.classList.remove('hidden');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Updating…';

    try {
      const data = await apiResetPassword({ token, password, confirmPassword });
      successEl.textContent = data.message + ' Redirecting to login…';
      successEl.classList.remove('hidden');
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Update password';
    }
  });
}

// ── VERIFY EMAIL ──────────────────────────────────────────────────────────────
async function renderVerifyEmail(params) {
  const token = params.token || '';

  setHTML(`
    ${renderNav(getUser())}
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo"><span class="brand-pulse">Patch</span>Ticker</div>
          <h1 class="auth-title">Verifying email…</h1>
        </div>
        <div id="verify-status">${spinner()}</div>
        <p class="auth-footer"><a class="auth-link" href="#/updates">Go to dashboard</a></p>
      </div>
    </div>
  `);
  attachNavHandlers(getUser());

  const statusEl = document.getElementById('verify-status');

  if (!token) {
    statusEl.innerHTML = '<p class="auth-error">No verification token found in the link.</p>';
    return;
  }

  try {
    const data = await apiVerifyEmail(token);
    statusEl.innerHTML = `<p class="auth-success-msg">✓ ${H(data.message)}</p>
      <a class="btn btn--primary" href="#/updates">Go to dashboard</a>`;
    showToast('Email verified!', 'success');
  } catch (err) {
    statusEl.innerHTML = `
      <p class="auth-error-msg">✗ ${H(err.message)}</p>
      <p class="auth-footer-note">Need a new link?</p>
      <button class="btn btn--secondary" id="resend-btn">Resend verification email</button>
    `;
    const resendBtn = document.getElementById('resend-btn');
    if (resendBtn) {
      resendBtn.addEventListener('click', async () => {
        resendBtn.disabled = true;
        try {
          await resendVerification();
          showToast('Verification email sent!', 'success');
        } catch (e) {
          showToast(e.message, 'error');
        } finally {
          resendBtn.disabled = false;
        }
      });
    }
  }
}

// ── PRICING ───────────────────────────────────────────────────────────────────
function renderPricing() {
  const user       = getUser();
  const isPro      = user && hasRole('pro');
  const monthlyId  = window.__STRIPE_PRICE_MONTHLY__ || '';
  const annualId   = window.__STRIPE_PRICE_ANNUAL__  || '';

  setHTML(`
    ${renderNav(user)}
    <div class="pricing-page">
      <div class="pricing-header">
        <div class="pricing-eyebrow">For patch-heavy setups</div>
        <h1 class="pricing-headline">Stay on top of games, launchers,<br>drivers, and platform services.</h1>
        <p class="pricing-subhead">Browse recent patches for free, then upgrade when you want alerts, watchlists, and deeper rollout intel.</p>
      </div>

      <div class="pricing-grid">
        <!-- Free tier -->
        <div class="pricing-card">
          <div class="pricing-card-header">
            <div class="pricing-tier">Free</div>
            <div class="pricing-price">$0<span class="pricing-period">/month</span></div>
            <div class="pricing-tagline">A strong daily landing page for staying current.</div>
          </div>
          <ul class="pricing-features">
            <li class="feature-item">✓ Full patch feed across tracked platforms</li>
            <li class="feature-item">✓ Recent service and launcher coverage</li>
            <li class="feature-item">✓ Clear install guidance</li>
            <li class="feature-item">✓ Community bug reports and votes</li>
            <li class="feature-item feature-item--muted">✗ Real-time watchlist alerts</li>
            <li class="feature-item feature-item--muted">✗ API access</li>
            <li class="feature-item feature-item--muted">✗ Priority report queue</li>
            <li class="feature-item feature-item--muted">✗ Advanced monitoring tools</li>
          </ul>
          <div class="pricing-cta">
            ${user
              ? isPro
                ? '<button class="btn btn--outline btn--full" disabled>Your current plan</button>'
                : '<button class="btn btn--outline btn--full" disabled>Current plan</button>'
              : '<a class="btn btn--outline btn--full" href="#/register">Get started free</a>'
            }
          </div>
        </div>

        <!-- Pro tier -->
        <div class="pricing-card pricing-card--featured">
          <div class="pricing-badge">Most popular</div>
          <div class="pricing-card-header">
            <div class="pricing-tier">Pro</div>
            <div class="pricing-price">$12<span class="pricing-period">/month</span></div>
            <div class="pricing-tagline">Or $99/year — save 31%</div>
          </div>
          <ul class="pricing-features">
            <li class="feature-item">✓ Everything in Free</li>
            <li class="feature-item feature-item--pro">✓ Real-time patch alerts (email)</li>
            <li class="feature-item feature-item--pro">✓ REST API access</li>
            <li class="feature-item feature-item--pro">✓ Priority bug report queue</li>
            <li class="feature-item feature-item--pro">✓ Advanced platform and service filtering</li>
            <li class="feature-item feature-item--pro">✓ Update history (12 months)</li>
            <li class="feature-item feature-item--pro">✓ Slack / webhook integrations</li>
            <li class="feature-item feature-item--pro">✓ Priority support</li>
          </ul>
          <div class="pricing-cta">
            ${isPro
              ? '<button class="btn btn--primary btn--full" id="portal-btn">Manage subscription</button>'
              : user
                ? `<button class="btn btn--primary btn--full" id="checkout-monthly" data-price="${H(monthlyId)}">Upgrade to Pro — $12/mo</button>
                   <button class="btn btn--ghost btn--full" id="checkout-annual" data-price="${H(annualId)}">Annual — $99/yr (save 31%)</button>`
                : `<a class="btn btn--primary btn--full" href="#/register">Start free trial</a>
                   <p class="pricing-trial-note">5-day free trial · No credit card required</p>`
            }
          </div>
        </div>

        <!-- Enterprise -->
        <div class="pricing-card">
          <div class="pricing-card-header">
            <div class="pricing-tier">Enterprise</div>
            <div class="pricing-price">Custom</div>
            <div class="pricing-tagline">For large teams and compliance needs.</div>
          </div>
          <ul class="pricing-features">
            <li class="feature-item">✓ Everything in Pro</li>
            <li class="feature-item feature-item--ent">✓ SSO / SAML</li>
            <li class="feature-item feature-item--ent">✓ Dedicated support SLA</li>
            <li class="feature-item feature-item--ent">✓ Custom data retention</li>
            <li class="feature-item feature-item--ent">✓ Audit logs</li>
            <li class="feature-item feature-item--ent">✓ On-prem deployment option</li>
          </ul>
          <div class="pricing-cta">
            <a class="btn btn--outline btn--full" href="mailto:enterprise@patchticker.app">Contact sales</a>
          </div>
        </div>
      </div>

      <div class="pricing-faq">
        <h2 class="faq-title">Common questions</h2>
        <div class="faq-grid">
          <div class="faq-item">
            <div class="faq-q">What happens after the trial?</div>
            <div class="faq-a">Your card is charged only after the 5-day trial ends. Cancel any time before then at no cost.</div>
          </div>
          <div class="faq-item">
            <div class="faq-q">Can I cancel at any time?</div>
            <div class="faq-a">Yes. Cancel from your billing portal and you'll keep Pro access until the end of your billing period.</div>
          </div>
          <div class="faq-item">
            <div class="faq-q">Is the free plan really free?</div>
            <div class="faq-a">Forever. No credit card required. The free tier is fully functional for individual developers.</div>
          </div>
          <div class="faq-item">
            <div class="faq-q">How does the API work?</div>
            <div class="faq-a">Pro users get a REST API key with up to 1,000 requests/day. Full docs included at launch.</div>
          </div>
        </div>
      </div>
    </div>
    ${renderFooter()}
  `);
  attachNavHandlers(user);
  const monthlyBtn = document.getElementById('checkout-monthly');
  const annualBtn  = document.getElementById('checkout-annual');
  const portalBtn  = document.getElementById('portal-btn');

  async function handleCheckout(btn, priceId) {
    if (!btn || !priceId) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Redirecting…';
      try {
        const { url } = await createCheckout(priceId);
        window.location.href = url;
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = btn.dataset.label || 'Upgrade';
      }
    });
  }

  if (monthlyBtn) { monthlyBtn.dataset.label = monthlyBtn.textContent; handleCheckout(monthlyBtn, monthlyId); }
  if (annualBtn)  { annualBtn.dataset.label  = annualBtn.textContent;  handleCheckout(annualBtn, annualId); }

  if (portalBtn) {
    portalBtn.addEventListener('click', async () => {
      portalBtn.disabled = true;
      portalBtn.textContent = 'Opening portal…';
      try {
        const { url } = await openBillingPortal();
        window.location.href = url;
      } catch (err) {
        showToast(err.message, 'error');
        portalBtn.disabled = false;
        portalBtn.textContent = 'Manage subscription';
      }
    });
  }
}

// ── LANDING ───────────────────────────────────────────────────────────────────
function renderLanding() {
  const user = getUser();

  setHTML(`
    ${renderNav(user)}
    <main class="landing-page">
      <section class="landing-hero">
        <div class="landing-copy">
          <p class="landing-kicker">Update safety research</p>
          <h1 class="landing-title">Know before you update.</h1>
          <p class="landing-subtitle">PatchTicker helps you decide whether the latest driver, OS patch, firmware release, or launcher update is worth installing today — before your setup becomes the test environment.</p>
          <div class="landing-actions">
            ${user
              ? '<a class="btn btn--primary" href="#/updates">Open update feed</a><a class="btn btn--outline" href="#/account">Manage watchlist</a>'
              : '<a class="btn btn--primary" href="#/register">Create free account</a><a class="btn btn--outline" href="#/updates">Browse live updates</a>'}
          </div>
          <div class="landing-proof">
            <span>11 tracked platforms</span>
            <span>Team-reviewed guidance</span>
            <span>Live community voting</span>
          </div>
        </div>

        <div class="landing-panel">
          <div class="landing-card-head">
            <span>Latest user signal</span>
            <span class="landing-live">LIVE</span>
          </div>
          <div class="landing-score-row">
            <strong>8.7</strong>
            <div>
              <span class="status-badge stable">STABLE</span>
              <p>NVIDIA Game Ready Driver</p>
            </div>
          </div>
          <div class="landing-meter"><span></span></div>
          <p class="landing-verdict">Minor regressions reported, broad install confidence remains high.</p>
          <div class="landing-votes">
            <span>Install 72%</span>
            <span>Wait 21%</span>
            <span>Avoid 7%</span>
          </div>
        </div>
      </section>

      <section class="landing-grid">
        <article>
          <h2>One read, not ten tabs.</h2>
          <p>Windows, NVIDIA, AMD, Apple, Switch, consoles, Steam, Epic, and Intel all land in one feed with clear install guidance.</p>
        </article>
        <article>
          <h2>Why it matters.</h2>
          <p>Each rating brings together release notes, security impact, known issues, user reports, and source links.</p>
        </article>
        <article>
          <h2>Alert when it matters.</h2>
          <p>Pro watchlists notify you when a platform you care about ships something that may affect your setup.</p>
        </article>
      </section>

      <section class="landing-band">
        <div>
          <p class="landing-kicker">Built for everyday install decisions</p>
          <h2>Stable / Caution / Avoid gives you a fast answer when an update is waiting.</h2>
        </div>
        <a class="btn btn--primary" href="#/pricing">See pricing</a>
      </section>
    </main>
    ${renderFooter()}
  `);
  attachNavHandlers(user);
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
const PLATFORM_CLASS = {
  AMD:'amd', NVIDIA:'nvidia', Apple:'apple', PS5:'ps5', Windows:'windows', Steam:'steam',
  macOS:'macos', Intel:'intel', Epic:'epic', Xbox:'xbox', Switch:'switch', Discord:'discord', BattleNet:'battlenet', GOG:'gog',
};
const PLATFORM_SHORT = { AMD:'AMD', NVIDIA:'NV', Apple:'', PS5:'PS5', Windows:'WIN', Steam:'STM', macOS:'MAC', Intel:'INT', Epic:'EPC', Xbox:'XBX', Switch:'SW', Discord:'DSC', BattleNet:'BNET', GOG:'GOG' };
const TRACKED_PLATFORMS = ['AMD','NVIDIA','Intel','Apple','macOS','Windows','Steam','Discord','BattleNet','GOG','Switch','Epic','Xbox','PS5'];
const TICKER_SERVICES = [
  'AMD', 'NVIDIA', 'Intel', 'Apple iOS', 'macOS', 'Windows',
  'Steam', 'Steam Deck', 'SteamOS', 'Discord', 'Battle.net', 'GOG Galaxy', 'Switch', 'Epic', 'Xbox', 'PS5',
];
const SEARCH_SUGGESTIONS = [
  'Steam Deck', 'SteamOS', 'Discord', 'Battle.net', 'GOG Galaxy',
  'Switch OLED', 'Joy-Con', 'MacBook Pro M3', 'MacBook Air M2',
  'RTX 4090', 'RTX 50', 'RX 7900 XT', 'Arc A770', 'VPN', 'anti-cheat',
];
const SEARCH_ALIASES = {
  steamos: ['steamos', 'steam os', 'steam deck', 'deck', 'valve handheld'],
  'steam deck': ['steam deck', 'steamos', 'deck', 'dock', 'docked'],
  cs2: ['cs2', 'counter-strike 2', 'counter strike 2', 'global offensive'],
  'counter strike': ['counter-strike 2', 'counter strike 2', 'cs2'],
  helldivers: ['helldivers', 'helldivers 2', 'anti-cheat', 'matchmaking'],
  switch: ['switch', 'nintendo', 'joy-con', 'joycon', 'switch oled', 'switch lite'],
  discord: ['discord', 'voice chat', 'overlay', 'rtc', 'rich presence'],
  battlenet: ['battle.net', 'battlenet', 'blizzard', 'warcraft', 'diablo', 'overwatch'],
  gog: ['gog', 'gog galaxy', 'galaxy client', 'cd projekt'],
  macbook: ['macbook', 'macbook pro', 'macbook air', 'm1', 'm2', 'm3', 'm4'],
  rtx: ['rtx', 'nvidia', 'dlss', 'game ready'],
  radeon: ['radeon', 'amd', 'rx 7900', 'adrenalin'],
};
const FOLLOWABLE_STEAM_GAMES = [
  { appId: '730', name: 'Counter-Strike 2', tags: 'cs2 counter strike competitive fps valve' },
  { appId: '553850', name: 'Helldivers 2', tags: 'helldivers co-op anti-cheat shooter' },
  { appId: '108694', name: 'Baldur’s Gate 3', tags: 'bg3 rpg larian' },
  { appId: '1172470', name: 'Apex Legends', tags: 'apex battle royale ea' },
  { appId: '570', name: 'Dota 2', tags: 'dota valve moba' },
  { appId: '252490', name: 'Rust', tags: 'rust survival facepunch' },
  { appId: '271590', name: 'Grand Theft Auto V', tags: 'gta online rockstar' },
  { appId: '1245620', name: 'Elden Ring', tags: 'fromsoftware souls' },
];

function platformSuffix(p) { return PLATFORM_CLASS[p] || 'default'; }
function platformLabel(p) { return ({ BattleNet: 'Battle.net', GOG: 'GOG Galaxy' })[p] || p; }

function searchableTextForUpdate(u) {
  const nested = [
    ...(u.changelog || []),
    ...(u.knownIssues || []),
    ...(u.riskFactors || []).map(r => `${r.level || ''} ${r.text || ''}`),
    ...(u.evidence || []).map(e => `${e.source || ''} ${e.text || ''}`),
    u.securityCriticality?.label || '',
    ...(u.securityCriticality?.cves || []),
  ];
  return [
    u.id, u.platform, u.name, u.version, u.affects, u.verdict, u.reasoning,
    ...nested,
  ].filter(Boolean).join(' ').toLowerCase();
}

function searchNeedles(raw) {
  const q = raw.toLowerCase().trim();
  if (!q) return [];
  const base = [q];
  for (const [key, aliases] of Object.entries(SEARCH_ALIASES)) {
    if (q === key || aliases.some(alias => alias.includes(q) || q.includes(alias))) {
      base.push(...aliases);
    }
  }
  return [...new Set(base.map(s => s.toLowerCase().trim()).filter(Boolean))];
}

function peerRatingMeta(update) {
  const rating = update?.userRating || null;
  const votes = Number(rating?.totalVotes || 0);
  const breakdown = rating?.breakdown || {};
  const install = Math.max(0, Math.min(100, Number(breakdown.install) || 0));
  const wait = Math.max(0, Math.min(100, Number(breakdown.wait) || 0));
  const avoid = Math.max(0, Math.min(100, Number(breakdown.avoid) || 0));
  const score = votes ? Number(rating.score ?? 0) : null;
  const label = !votes ? 'Waiting for user votes'
    : install >= 70 ? 'Users say install'
      : avoid >= 35 ? 'Users say avoid'
        : wait >= 35 ? 'Users say wait'
          : 'Mixed community signal';
  return { score, install, wait, avoid, label, votes };
}


function getFollowedSteamGames() {
  try { return JSON.parse(localStorage.getItem('patchticker.followedSteamGames') || '[]'); }
  catch { return []; }
}

function setFollowedSteamGames(games) {
  localStorage.setItem('patchticker.followedSteamGames', JSON.stringify(games));
}

function findSteamGame(query) {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  return FOLLOWABLE_STEAM_GAMES.find(g =>
    g.name.toLowerCase().includes(q) || g.appId === q || g.tags.toLowerCase().includes(q)
  ) || { appId: q.replace(/\D/g, '') || `custom-${Date.now()}`, name: query.trim(), tags: query.trim().toLowerCase() };
}

function scoreColor(score) {
  // Returns an interpolated hex between red (#f87171) and green (#4ade80) based on score 0–10
  const t   = Math.max(0, Math.min(10, score)) / 10;
  const r   = Math.round(248 + (74  - 248) * t);
  const g   = Math.round(113 + (222 - 113) * t);
  const b   = Math.round(113 + (128 - 113) * t);
  return `rgb(${r},${g},${b})`;
}

// ── Bug report community feed renderer ───────────────────────────────────────
// Shared between the detail page and the platform page.
// Renders bug reports as a social community feed with severity badges,
// timestamps, and a submit form for Pro users.

function renderBugFeed(containerEl, reports, updateId) {
  const user = getUser();
  const isPro = user?.role === 'pro' || user?.role === 'admin';

  const SEVERITY_META = {
    critical: { color: 'var(--red)',    label: 'Critical', icon: '🔴' },
    high:     { color: '#f97316', label: 'High', icon: '🟠' },
    medium:   { color: 'var(--yellow)', label: 'Medium',   icon: '🟡' },
    low:      { color: 'var(--green)',  label: 'Low',      icon: '🔵' },
  };

  function reportCard(r) {
    const meta = SEVERITY_META[r.severity] || SEVERITY_META.low;
    const ago  = timeAgo(r.createdAt);
    return `
      <div class="bug-card">
        <div class="bug-card-header">
          <span class="bug-severity-badge" style="background:${meta.color}20;border-color:${meta.color};color:${meta.color}">
            ${meta.icon} ${meta.label}
          </span>
          <span class="bug-card-time">${ago}</span>
        </div>
        <p class="bug-card-body">${H(r.description)}</p>
      </div>
    `;
  }

  const listHTML = reports.length
    ? reports.map(reportCard).join('')
    : '<p class="bug-feed-empty">No bug reports yet. Be the first to report an issue.</p>';

  const formHTML = isPro ? `
    <div class="bug-submit-box" id="bug-submit-box-${H(updateId)}">
      <h3 class="bug-submit-title">Report a bug</h3>
      <div id="bug-submit-error-${H(updateId)}" class="account-alert account-alert--error hidden"></div>
      <div id="bug-submit-ok-${H(updateId)}"    class="account-alert account-alert--success hidden">Report submitted. Thanks!</div>
      <select class="field-input bug-severity-select" id="bug-severity-${H(updateId)}">
        <option value="">— Severity —</option>
        <option value="critical">🔴 Critical</option>
        <option value="high">🟠 High</option>
        <option value="medium">🟡 Medium</option>
        <option value="low">🔵 Low</option>
      </select>
      <textarea class="field-input bug-desc-input" id="bug-desc-${H(updateId)}"
        placeholder="Describe the issue clearly — hardware, OS version, steps to reproduce…"
        rows="3" maxlength="1000"></textarea>
      <button class="btn btn--primary btn--sm" id="bug-submit-btn-${H(updateId)}">Submit report</button>
    </div>
  ` : user ? `
    <div class="bug-upsell">
      <span>🔒</span> <a href="#/pricing">Upgrade to Pro</a> to submit bug reports
    </div>
  ` : `
    <div class="bug-upsell">
      <a href="#/login">Sign in</a> to submit bug reports
    </div>
  `;

  containerEl.innerHTML = `
    <div class="bug-feed">
      <div class="bug-feed-list" id="bug-feed-list-${H(updateId)}">${listHTML}</div>
      ${formHTML}
    </div>
  `;

  // Wire submit button
  const submitBtn = document.getElementById(`bug-submit-btn-${updateId}`);
  if (!submitBtn) return;

  submitBtn.addEventListener('click', async () => {
    const errEl  = document.getElementById(`bug-submit-error-${updateId}`);
    const okEl   = document.getElementById(`bug-submit-ok-${updateId}`);
    const severity = document.getElementById(`bug-severity-${updateId}`)?.value;
    const description = document.getElementById(`bug-desc-${updateId}`)?.value?.trim();

    errEl.classList.add('hidden');
    okEl.classList.add('hidden');

    if (!severity)    { errEl.textContent = 'Please select a severity.'; errEl.classList.remove('hidden'); return; }
    if (!description || description.length < 10) {
      errEl.textContent = 'Description must be at least 10 characters.';
      errEl.classList.remove('hidden'); return;
    }

    submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';
    try {
      const { submitBugReport } = await import('./api.js');
      const result = await submitBugReport({ updateId, severity, description });

      okEl.classList.remove('hidden');
      document.getElementById(`bug-severity-${updateId}`).value = '';
      document.getElementById(`bug-desc-${updateId}`).value = '';

      // Prepend new report to feed optimistically
      const listEl = document.getElementById(`bug-feed-list-${updateId}`);
      if (listEl && result?.data) {
        const newCard = document.createElement('div');
        newCard.innerHTML = reportCard(result.data);
        listEl.prepend(newCard.firstElementChild);
        const emptyMsg = listEl.querySelector('.bug-feed-empty');
        if (emptyMsg) emptyMsg.remove();
      }
    } catch (err) {
      errEl.textContent = err.message || 'Submission failed. Please try again.';
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = 'Submit report';
    }
  });
}

// ── Time ago helper ───────────────────────────────────────────────────────────
function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  1) return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}


function decisionForUpdate(u) {
  const vote = u.userRating?.breakdown || {};
  if (u.status === 'avoid' || (vote.avoid || 0) >= 35 || u.score < 4.5) return { label: 'Avoid for now', cls: 'avoid', action: 'AVOID' };
  if (u.status === 'caution' || (vote.wait || 0) >= 30 || u.score < 7) return { label: 'Wait and watch', cls: 'caution', action: 'WAIT' };
  return { label: 'Safe to install', cls: 'stable', action: 'INSTALL' };
}

function primaryRiskText(u) {
  const risk = (u.riskFactors || []).find(r => ['critical', 'high'].includes(r.level)) || (u.riskFactors || [])[0];
  if (risk?.text) return risk.text;
  if ((u.knownIssues || [])[0]) return (u.knownIssues || [])[0];
  return u.status === 'stable' ? 'No major issue pattern found yet.' : 'Watch user reports before installing.';
}

function setupMatchScore(u, terms) {
  const text = searchableTextForUpdate(u);
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

function renderScoreBar(score, status) {
  const pct   = Math.round((score / 10) * 100);
  const color = scoreColor(score);
  return `
    <div class="score-bar-wrap" title="Score: ${H(String(score))} / 10">
      <div class="score-bar-track">
        <div class="score-bar-fill" style="height:${pct}%;background:${color};box-shadow:0 0 8px ${color}55"></div>
      </div>
      <div class="score-bar-value" style="color:${color}">${H(String(score))}</div>
    </div>
  `;
}


function renderInlineUpdatePanel(u, decision, rating, risk) {
  const releaseNotes = (u.changelog || []).slice(0, 8);
  const knownIssues = (u.knownIssues || []).slice(0, 6);
  const riskFactors = (u.riskFactors || []).slice(0, 6);
  const evidence = (u.evidence || []).slice(0, 6);
  const security = u.securityCriticality || {};
  const securityLabel = security.label || security.level || 'Not flagged as security-critical yet';
  const cves = security.cves || [];
  const ratingBreakdown = rating.breakdown || u.userRating?.breakdown || {};

  return `
    <div class="decision-expanded" hidden>
      <div class="decision-expanded-grid">
        <section class="decision-expanded-block decision-expanded-block--wide">
          <span>Update overview</span>
          <p>${H(u.reasoning || u.verdict || risk || 'PatchTicker is still gathering source notes and user reports for this update.')}</p>
        </section>

        <section class="decision-expanded-block">
          <span>Release notes</span>
          <ul>${releaseNotes.length ? releaseNotes.map(c => `<li>${H(c)}</li>`).join('') : '<li>No release notes loaded yet.</li>'}</ul>
        </section>

        <section class="decision-expanded-block">
          <span>Known issues</span>
          <ul>${knownIssues.length ? knownIssues.map(i => `<li>${H(i)}</li>`).join('') : '<li>No major known issues recorded yet.</li>'}</ul>
        </section>

        <section class="decision-expanded-block">
          <span>Risk factors</span>
          <ul>${riskFactors.length ? riskFactors.map(r => `<li><strong>${H(r.level || 'watch')}</strong> — ${H(r.text || r)}</li>`).join('') : `<li>${H(risk || 'No specific risk factor has been detected yet.')}</li>`}</ul>
        </section>

        ${rating.votes ? `
        <section class="decision-expanded-block">
          <span>User rating</span>
          <div class="decision-vote-breakdown">
            <div><b style="width:${Number(ratingBreakdown.install || 0)}%"></b><em>Install</em><strong>${H(String(ratingBreakdown.install || 0))}%</strong></div>
            <div><b style="width:${Number(ratingBreakdown.wait || 0)}%"></b><em>Wait</em><strong>${H(String(ratingBreakdown.wait || 0))}%</strong></div>
            <div><b style="width:${Number(ratingBreakdown.avoid || 0)}%"></b><em>Avoid</em><strong>${H(String(ratingBreakdown.avoid || 0))}%</strong></div>
          </div>
          <p class="decision-expanded-note">${H(String(rating.votes))} user votes counted.</p>
        </section>` : ''}

        <section class="decision-expanded-block">
          <span>Security context</span>
          <p>${H(securityLabel)}</p>
          ${cves.length ? `<div class="decision-cve-row">${cves.slice(0, 6).map(cve => `<code>${H(cve)}</code>`).join('')}</div>` : '<p class="decision-expanded-note">No CVE list attached to this update yet.</p>'}
        </section>

        <section class="decision-expanded-block decision-expanded-block--wide">
          <span>Sources</span>
          <div class="decision-source-list">
            ${evidence.length ? evidence.map(e => `
              <a href="${H(e.url || '#')}" target="_blank" rel="noopener noreferrer">
                <strong>${H(e.source || 'Source')}</strong>
                <small>${H(e.text || e.url || 'Open source')}</small>
              </a>
            `).join('') : '<p class="decision-expanded-note">No source links attached yet.</p>'}
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderUpdateCard(u) {
  const pSuffix = platformSuffix(u.platform);
  const short   = PLATFORM_SHORT[u.platform] ?? u.platform.slice(0,3).toUpperCase();
  const decision = decisionForUpdate(u);
  const rating = peerRatingMeta(u);
  const install = rating.install || 0;
  const risk = primaryRiskText(u);
  const age = timeAgo(u.releasedAt);
  const affected = (u.affects || '').split('/').map(x => x.trim()).filter(Boolean).slice(0, 3);
  return `
    <article class="decision-card decision-card--${H(decision.cls)}" data-id="${H(u.id)}">
      <div class="decision-card-answer">
        <span class="decision-action decision-action--${H(decision.cls)}">${H(decision.action)}</span>
        <strong>${H(decision.label)}</strong>
        <span>${H(String(u.score))}/10 safety</span>
      </div>

      <div class="decision-card-body">
        <div class="decision-card-head">
          <span class="update-platform-icon platform--${pSuffix} decision-platform-icon">${H(short)}</span>
          <div>
            <button class="decision-title decision-title--button" type="button" data-expand-toggle aria-expanded="false">${H(u.name)}</button>
            <div class="decision-meta">
              <a class="text-platform--${pSuffix}" href="#/platform/${H(u.platform)}">${H(platformLabel(u.platform))}</a>
              <span>·</span><span>${H(formatReleaseDate(u.releasedAt))}</span>
              <span>·</span><span>${H(age)}</span>
            </div>
          </div>
        </div>

        <p class="decision-takeaway">${H(u.verdict || risk)}</p>

        <div class="decision-chips">
          ${affected.map(a => `<span>${H(a)}</span>`).join('') || `<span>${H(platformLabel(u.platform))}</span>`}
        </div>

        <div class="decision-timeline" aria-label="Update review timeline">
          <span class="is-done">Released</span>
          <span class="is-done">Reports checked</span>
          <span class="is-active">Current rating</span>
        </div>

      </div>

      <div class="decision-card-side">
        ${rating.votes ? `
        <div class="decision-user-meter">
          <span>User rating</span>
          <strong>${rating.score !== null ? rating.score.toFixed(1) : '—'}</strong>
          <div class="decision-meter-track"><i style="width:${install}%"></i></div>
          <em>${install}% install</em>
        </div>` : `
        <div class="decision-user-meter decision-user-meter--empty">
          <span>Patch notes</span>
          <strong>—</strong>
          <em>Votes pending</em>
        </div>`}
        <div class="decision-risk">
          <span>Watch for</span>
          <p>${H(risk)}</p>
        </div>
        <button class="decision-open" type="button" data-expand-toggle aria-expanded="false">Click to open ↓</button>
      </div>

      ${renderInlineUpdatePanel(u, decision, rating, risk)}
    </article>
  `;
}

function normaliseUpdatesResponse(res) {
  return Array.isArray(res) ? res : (res?.data || []);
}

function formatReleaseDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderMiniUpdateCard(u, variant = 'default') {
  const pSuffix = platformSuffix(u.platform);
  const short   = PLATFORM_SHORT[u.platform] ?? u.platform.slice(0, 3).toUpperCase();
  const tone    = variant === 'compact' ? ' mini-update-card--compact' : '';
  return `
    <a class="mini-update-card${tone}" href="#/update/${H(u.id)}">
      <div class="mini-update-top">
        <span class="update-platform-icon platform--${pSuffix} mini-update-icon">${H(short)}</span>
        <span class="mini-update-status status-badge ${H(u.status)}">${H(u.status)}</span>
      </div>
      <div class="mini-update-title">${H(u.name)}</div>
      <div class="mini-update-meta">
        <span class="text-platform--${pSuffix}">${H(platformLabel(u.platform))}</span>
        <span>·</span>
        <span>${H(formatReleaseDate(u.releasedAt))}</span>
      </div>
      <p class="mini-update-copy">${H(u.verdict || u.affects || 'Recent patch coverage available.')}</p>
      <div class="mini-update-score" style="color:${scoreColor(u.score)}">${H(String(u.score))}/10</div>
    </a>
  `;
}

function renderRadarCard(title, description, updates) {
  const body = updates.length
    ? updates.map((u) => renderMiniUpdateCard(u, 'compact')).join('')
    : '<p class="dash-empty-copy">No tracked patches in this lane yet.</p>';
  return `
    <section class="radar-card">
      <div class="radar-card-header">
        <p class="radar-card-kicker">${H(title)}</p>
        <p class="radar-card-desc">${H(description)}</p>
      </div>
      <div class="radar-card-list">${body}</div>
    </section>
  `;
}


function renderCompareCard(label, u) {
  if (!u) return '<p class="dash-empty-copy">No comparison data available yet.</p>';
  const decision = decisionForUpdate(u);
  const rating = peerRatingMeta(u);
  return `
    <a class="compare-card compare-card--${H(decision.cls)}" href="#/update/${H(u.id)}">
      <span class="compare-label">${H(label)}</span>
      <strong>${H(u.name)}</strong>
      <div class="compare-meta">
        <span>${H(platformLabel(u.platform))}</span>
        <span>${H(String(u.score))}/10 safety</span>
        ${rating.votes ? `<span>${H(String(rating.votes))} votes</span>` : '<span>patch notes only</span>'}
      </div>
      <p>${H(primaryRiskText(u))}</p>
    </a>
  `;
}

function renderSubscriptionBanner(billingData) {
  if (!billingData) return '';
  const { role, subscription: sub } = billingData;

  if (role === 'admin') {
    return `<div class="sub-banner sub-banner--admin">👑 Admin — full access</div>`;
  }
  if (role === 'pro' && sub) {
    const end    = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : '—';
    const cancel = sub.cancelAtPeriodEnd ? ` · Cancels ${end}` : ` · Renews ${end}`;
    const trial  = sub.trialEnd && new Date(sub.trialEnd) > new Date()
      ? ` · Trial ends ${new Date(sub.trialEnd).toLocaleDateString()}`
      : '';
    return `
      <div class="sub-banner sub-banner--pro">
        <div class="sub-banner-left">
          <span class="sub-badge">PRO</span>
          <span class="sub-status">${H(sub.status)}${trial || cancel}</span>
        </div>
        <button class="sub-manage-btn" id="manage-sub-btn">Manage subscription</button>
      </div>
    `;
  }
  return `
    <div class="sub-banner sub-banner--free">
      <span>You're on the <strong>Free</strong> plan.</span>
      <a class="sub-upgrade-link" href="#/pricing">Upgrade to Pro →</a>
    </div>
  `;
}

async function renderDashboard() {
  const user = getUser();
  const isAuthed = !!user;

  setHTML(`
    ${renderNav(user)}

    <div class="dash-wrap">

      <!-- Subscription banner -->
      <div id="sub-banner-slot"></div>

      <div class="service-ticker" aria-label="Supported PatchTicker services">
        <div class="service-ticker-track">
          ${[...TICKER_SERVICES, ...TICKER_SERVICES].map(service => `
            <span class="service-ticker-item">${H(service)}</span>
          `).join('')}
        </div>
      </div>

      <!-- Hero strip -->
      <div class="dash-hero">
        <div class="dash-hero-inner">
          <div class="dash-hero-text">
            <p class="dash-hero-kicker">Your update safety desk</p>
            <h1 class="dash-hero-title">Know what to install, what to wait on, and what to <span>avoid.</span></h1>
            <p class="dash-hero-sub">The PatchTicker team gathers release notes, user votes, bug reports, and trusted sources so you can decide what belongs on your device today.</p>
            <section class="setup-lens-panel setup-lens-panel--hero">
              <div class="setup-lens-intro">
                <p class="dash-section-kicker">Choose your setup</p>
                <p class="setup-lens-copy">Filter PatchTicker around the gear, launchers, and games you actually use.</p>
              </div>
              <div class="setup-lens-grid">
                <button class="setup-lens active" data-lens="" data-label="Everything"><span>Everything</span><em>All tracked patches</em></button>
                <button class="setup-lens" data-lens="nvidia amd intel windows steam discord battle.net gog" data-label="Gaming PC"><span>Gaming PC</span><em>Drivers, Windows, launchers, chat</em></button>
                <button class="setup-lens" data-lens="macos apple macbook" data-label="Work Mac"><span>Work Mac</span><em>macOS, Apple, MacBook</em></button>
                <button class="setup-lens" data-lens="steam deck steamos" data-label="Steam Deck"><span>Steam Deck</span><em>SteamOS and handheld updates</em></button>
                <button class="setup-lens" data-lens="switch xbox ps5 console" data-label="Console"><span>Console</span><em>Switch, Xbox, PlayStation</em></button>
              </div>
            </section>
            <div class="dash-hero-actions">
              <a class="btn btn--primary" href="#updates-list">Browse recent patches</a>
              ${isAuthed
                ? '<a class="btn btn--secondary" href="#/account">Manage your watchlist</a>'
                : '<a class="btn btn--outline" href="#/register">Create a free account</a>'}
            </div>
            <div class="dash-hero-notes">
              <span class="dash-note-pill">User install confidence</span>
              <span class="dash-note-pill">Device and game-specific search</span>
              <span class="dash-note-pill">Bug reports before you update</span>
            </div>
          </div>
          <div class="dash-hero-side">
            <div class="dash-hero-stats" id="dash-hero-stats">
              <div class="dash-stat"><span class="dash-stat-val" id="stat-stable">—</span><span class="dash-stat-label">Stable</span></div>
              <div class="dash-stat-divider"></div>
              <div class="dash-stat"><span class="dash-stat-val dash-stat-val--caution" id="stat-caution">—</span><span class="dash-stat-label">Caution</span></div>
              <div class="dash-stat-divider"></div>
              <div class="dash-stat"><span class="dash-stat-val dash-stat-val--avoid" id="stat-avoid">—</span><span class="dash-stat-label">Avoid</span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Platform quick-nav -->
      <div class="dash-platform-strip">
        ${TRACKED_PLATFORMS.map(p => {
          const suffix = PLATFORM_CLASS[p] || 'default';
          const short  = PLATFORM_SHORT[p] || p.slice(0,3).toUpperCase();
          return `<a class="platform-pill platform--${suffix}" href="#/platform/${H(p)}" title="${H(platformLabel(p))}">
            <span class="platform-pill-icon">${H(short)}</span>
            <span class="platform-pill-name">${H(platformLabel(p))}</span>
          </a>`;
        }).join('')}
      </div>

      <section class="update-tape-panel" aria-label="Live update tape">
        <div class="update-tape-label">Update tape</div>
        <div class="update-tape-window">
          <div class="update-tape-track" id="update-tape-track">${spinner()}</div>
        </div>
      </section>

      ${hasRole('pro') || user?.role === 'admin' ? `
      <section class="follow-games-panel">
        <div class="dash-section-header dash-section-header--tight">
          <div>
            <p class="dash-section-kicker">Pro game tracking</p>
            <h2 class="dash-section-title">Follow my games</h2>
          </div>
          <p class="dash-section-copy">Track Steam patch notes for the games you actually play. These follows stay on this device until account sync is wired in.</p>
        </div>
        <div class="follow-games-box">
          <div class="follow-games-search">
            <input class="dash-search" id="follow-game-input" type="search" placeholder="Search Steam games… e.g. Apex, Dota, Rust" autocomplete="off" />
            <button class="btn btn--primary btn--sm" id="follow-game-add">Follow</button>
          </div>
          <div class="follow-game-suggestions" id="follow-game-suggestions"></div>
          <div class="followed-games" id="followed-games"></div>
        </div>
      </section>
      ` : ''}

      <div class="dash-highlights">
        <div class="dash-section-header">
          <div>
            <p class="dash-section-kicker">Right now</p>
            <h2 class="dash-section-title">Start with what matters now</h2>
          </div>
          <p class="dash-section-copy">A quick path to the updates most likely to affect your device, games, or workflow.</p>
        </div>
        <div class="dash-radar-grid" id="dash-radar-grid">
          ${spinner()}
        </div>
      </div>

      <section class="compare-panel">
        <div class="dash-section-header dash-section-header--tight">
          <div>
            <p class="dash-section-kicker">Compare before installing</p>
            <h2 class="dash-section-title">Best choice vs. highest risk</h2>
          </div>
          <p class="dash-section-copy">A quick contrast between what users trust and what deserves patience.</p>
        </div>
        <div class="compare-strip" id="compare-strip">${spinner()}</div>
      </section>

      <!-- Main content area -->
      <div class="dash-main">

        <!-- Filter + feed column -->
        <div class="dash-feed-col">

          <section class="dash-section">
            <div class="dash-section-header dash-section-header--tight">
              <div>
                <p class="dash-section-kicker">Worth a look</p>
                <h2 class="dash-section-title">Latest updates to check before installing</h2>
              </div>
              <p class="dash-section-copy">Open any card for the takeaway, known issues, user votes, and source links.</p>
            </div>
            <div class="dash-feature-grid" id="dash-feature-grid">
              ${spinner()}
            </div>
          </section>

          <!-- Filter bar -->
          <div class="dash-filterbar">
            <div class="dash-search-wrap">
              <span class="dash-search-icon">⌕</span>
              <input
                class="dash-search"
                id="dash-search"
                type="search"
                placeholder="Search devices, platforms, games… e.g. Steam Deck, MacBook, RTX"
                list="dash-search-suggestions"
                autocomplete="off"
                spellcheck="false"
              />
              <datalist id="dash-search-suggestions">
                ${SEARCH_SUGGESTIONS.map(term => `<option value="${H(term)}"></option>`).join('')}
              </datalist>
              <button class="dash-search-clear hidden" id="dash-search-clear" aria-label="Clear">✕</button>
            </div>

            <div class="dash-filter-chips">
              <div class="dash-chip-group" id="status-filters">
                <button class="chip active" data-status="">All</button>
                <button class="chip chip--stable"  data-status="stable">✓ Stable</button>
                <button class="chip chip--caution" data-status="caution">⚠ Caution</button>
                <button class="chip chip--avoid"   data-status="avoid">✕ Avoid</button>
              </div>
              <select class="dash-sort" id="dash-sort">
                <option value="date_desc">Newest</option>
                <option value="date_asc">Oldest</option>
                <option value="score_desc">Score ↓</option>
                <option value="score_asc">Score ↑</option>
              </select>
            </div>

            <div class="dash-platform-chips" id="platform-filters">
              <button class="chip active" data-platform="">All platforms</button>
              <button class="chip" data-platform="AMD">AMD</button>
              <button class="chip" data-platform="NVIDIA">NVIDIA</button>
              <button class="chip" data-platform="Intel">Intel</button>
              <button class="chip" data-platform="Apple">Apple</button>
              <button class="chip" data-platform="macOS">macOS</button>
              <button class="chip" data-platform="Windows">Windows</button>
              <button class="chip" data-platform="Steam">Steam</button>
              <button class="chip" data-platform="Discord">Discord</button>
              <button class="chip" data-platform="BattleNet">Battle.net</button>
              <button class="chip" data-platform="GOG">GOG</button>
              <button class="chip" data-platform="Switch">Switch</button>
              <button class="chip" data-platform="Epic">Epic</button>
              <button class="chip" data-platform="Xbox">Xbox</button>
              <button class="chip" data-platform="PS5">PS5</button>
            </div>

            <div class="dash-active-filters hidden" id="dash-active-filters">
              <span id="dash-filter-summary"></span>
              <button class="dash-clear-all" id="dash-clear-all">Clear filters</button>
            </div>
          </div>

          <!-- Update cards -->
          <div id="updates-list" class="updates-list">${spinner()}</div>

          <!-- AdSense -->
          ${shouldShowAds() ? `
            <div id="ad-slot-dashboard" class="ad-slot ad-slot--banner" aria-label="Advertisement"></div>
          ` : ''}

          <!-- Bug report form (Pro) -->
          ${hasRole('pro') || user?.role === 'admin' ? `
            <div class="bug-report-panel">
              <div class="bug-report-panel-header">
                <span class="pro-badge-label">PRO</span>
                <h2 class="bug-report-panel-title">Submit Bug Report</h2>
              </div>
              <form class="bug-report-form" id="bug-form">
                <div class="bug-form-row">
                  <div class="field-group">
                    <label class="field-label" for="bug-update">Update ID</label>
                    <input class="field-input" id="bug-update" type="text" placeholder="e.g. nvidia-572-16" />
                  </div>
                  <div class="field-group">
                    <label class="field-label" for="bug-severity">Severity</label>
                    <select class="field-input" id="bug-severity">
                      <option value="low">Low</option>
                      <option value="medium" selected>Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>
                </div>
                <div class="field-group">
                  <label class="field-label" for="bug-desc">Description</label>
                  <textarea class="field-input field-textarea" id="bug-desc" rows="3"
                    placeholder="Describe the issue — hardware, OS version, steps to reproduce…"></textarea>
                </div>
                <div class="bug-form-error hidden" id="bug-error"></div>
                <button class="btn btn--primary" type="submit" id="bug-submit">Submit report</button>
              </form>
            </div>
          ` : !isAuthed ? `
            <div class="guest-cta-panel">
              <div class="guest-cta-copy">
                <p class="guest-cta-kicker">Join the watchlist</p>
                <h3 class="guest-cta-title">Make this your pre-update check.</h3>
                <p class="guest-cta-text">Create a free account to save platforms, follow user ratings, and post in the live feed.</p>
              </div>
              <div class="guest-cta-actions">
                <a class="btn btn--primary" href="#/register">Create free account</a>
                <a class="btn btn--ghost" href="#/login">Sign in</a>
              </div>
            </div>
          ` : ''}

        </div>

        <!-- Right sidebar: live feed only -->
        <aside class="dash-sidebar">
          <div class="feed-sidebar" id="feed-sidebar">
            <div class="feed-header">
              <span class="feed-title">LIVE FEED</span>
              <span class="feed-dot" id="feed-dot" title="Connecting…"></span>
            </div>
            <div class="feed-messages" id="feed-messages"></div>
            ${isAuthed ? `
              <div class="feed-compose">
                <input
                  class="feed-input"
                  id="feed-input"
                  type="text"
                  placeholder="Post to feed…"
                  maxlength="280"
                  autocomplete="off"
                  spellcheck="false"
                />
                <button class="feed-send" id="feed-send" aria-label="Send">↑</button>
              </div>
            ` : `
              <div class="feed-guest-panel">
                <p class="feed-guest-title">Browse the room, then sign in to post.</p>
                <a class="btn btn--outline btn--full" href="#/login">Sign in for live chat</a>
              </div>
            `}
          </div>
        </aside>

      </div><!-- /.dash-main -->
    </div><!-- /.dash-wrap -->
    ${renderFooter()}
  `);
  attachNavHandlers(user);

  // Inject AdSense banner for free-tier users.
  injectAd('ad-slot-dashboard', 'auto');

  // Load billing status
  if (isAuthed) {
    try {
      const billing = await getBillingStatus();
      document.getElementById('sub-banner-slot').innerHTML = renderSubscriptionBanner(billing);
      const manageBtn = document.getElementById('manage-sub-btn');
      if (manageBtn) {
        manageBtn.addEventListener('click', async () => {
          manageBtn.disabled = true;
          try {
            const { url } = await openBillingPortal();
            window.location.href = url;
          } catch (err) {
            showToast(err.message, 'error');
            manageBtn.disabled = false;
          }
        });
      }
    } catch {
      document.getElementById('sub-banner-slot').innerHTML = '';
    }
  }

  // ── Filter state ─────────────────────────────────────────────────────────────
  // All filtering is client-side on the cached dataset for instant response.
  // The initial fetch loads all updates; subsequent filter changes re-render
  // from the cache without hitting the network.
  let _allUpdates  = [];   // full dataset from last fetch
  let _filterState = { platform: '', status: '', sort: 'date_desc', search: '' };

  function applyFilters() {
    const { platform, status, sort, search } = _filterState;
    let filtered = _allUpdates;

    if (platform) filtered = filtered.filter(u => u.platform === platform);
    if (status)   filtered = filtered.filter(u => u.status   === status);
    if (search) {
      const needles = searchNeedles(search);
      filtered = filtered.filter(u => {
        const haystack = searchableTextForUpdate(u);
        return needles.some(q => haystack.includes(q));
      });
    }

    const sorters = {
      date_desc:  (a, b) => new Date(b.releasedAt) - new Date(a.releasedAt),
      date_asc:   (a, b) => new Date(a.releasedAt) - new Date(b.releasedAt),
      score_desc: (a, b) => b.score - a.score,
      score_asc:  (a, b) => a.score - b.score,
    };
    if (sorters[sort]) filtered = [...filtered].sort(sorters[sort]);

    const listEl = document.getElementById('updates-list');
    if (!listEl) return;

    if (!filtered.length) {
      const hasFilters = platform || status || search;
      listEl.innerHTML = hasFilters
        ? '<p class="empty-state">No updates match your filters. <button class="link-btn" id="clear-inline">Clear filters</button></p>'
        : '<p class="empty-state">No updates found.</p>';
      document.getElementById('clear-inline')?.addEventListener('click', clearAllFilters);
    } else {
      listEl.innerHTML = filtered.map(renderUpdateCard).join('');
    }

    updateFilterSummary();
  }

  function updateFilterSummary() {
    const { platform, status, search } = _filterState;
    const summaryEl  = document.getElementById('dash-filter-summary');
    const containerEl = document.getElementById('dash-active-filters');
    if (!summaryEl || !containerEl) return;

    const parts = [];
    if (platform) parts.push(`Platform: <strong>${H(platformLabel(platform))}</strong>`);
    if (status)   parts.push(`Status: <strong>${H(status)}</strong>`);
    if (search)   parts.push(`Search: <strong>"${H(search)}"</strong>`);

    if (parts.length) {
      summaryEl.innerHTML = parts.join(' · ');
      containerEl.classList.remove('hidden');
    } else {
      containerEl.classList.add('hidden');
    }
  }

  function clearAllFilters() {
    _filterState = { platform: '', status: '', sort: _filterState.sort, search: '' };

    document.querySelectorAll('#platform-filters .chip').forEach(b =>
      b.classList.toggle('active', b.dataset.platform === '')
    );
    document.querySelectorAll('#status-filters .chip').forEach(b =>
      b.classList.toggle('active', b.dataset.status === '')
    );
    const searchEl = document.getElementById('dash-search');
    if (searchEl) searchEl.value = '';
    document.getElementById('dash-search-clear')?.classList.add('hidden');
    document.querySelectorAll('.setup-lens').forEach(b => b.classList.toggle('active', b.dataset.lens === ''));

    applyFilters();
  }

  document.getElementById('updates-list')?.addEventListener('click', (e) => {
    const card = e.target.closest('.decision-card');
    if (!card) return;
    if (e.target.closest('a')) return;
    const explicitToggle = e.target.closest('[data-expand-toggle]');
    const clickedCardShell = e.target === card || e.target.closest('.decision-card-answer, .decision-card-head, .decision-takeaway, .decision-chips, .decision-timeline, .decision-card-side');
    if (!explicitToggle && !clickedCardShell) return;

    const panel = card.querySelector('.decision-expanded');
    if (!panel) return;
    const isOpen = card.classList.toggle('is-expanded');
    panel.hidden = !isOpen;
    card.querySelectorAll('[data-expand-toggle]').forEach(btn => {
      btn.setAttribute('aria-expanded', String(isOpen));
      if (btn.classList.contains('decision-open')) btn.textContent = isOpen ? 'Close details ↑' : 'Click to open ↓';
    });
  });

  function renderOfflineRails(message = 'Live patch feed is reconnecting. Showing recent PatchTicker coverage.') {
    const fallback = typeof getStaticUpdates === 'function' ? getStaticUpdates() : [];
    const featureGrid = document.getElementById('dash-feature-grid');
    const radarGrid = document.getElementById('dash-radar-grid');
    const listEl = document.getElementById('updates-list');
    if (featureGrid) {
      featureGrid.innerHTML = fallback.slice(0, 3).map(renderMiniUpdateCard).join('') || `<p class="dash-empty-copy">${H(message)}</p>`;
    }
    if (radarGrid) {
      const newest = fallback.slice(0, 9);
      const servicePlatforms = new Set(['Steam', 'Discord', 'BattleNet', 'GOG', 'Switch', 'PS5', 'Xbox', 'Epic']);
      const pcPlatforms = new Set(['AMD', 'NVIDIA', 'Intel', 'Windows', 'Apple', 'macOS']);
      radarGrid.innerHTML = [
        renderRadarCard('Recent coverage', message, newest.slice(0, 3)),
        renderRadarCard('Apps and consoles', 'Launcher, storefront, console, and handheld patches worth checking.', newest.filter(u => servicePlatforms.has(u.platform)).slice(0, 3)),
        renderRadarCard('PC essentials', 'Drivers and operating-system updates that can change performance or stability.', newest.filter(u => pcPlatforms.has(u.platform)).slice(0, 3)),
      ].join('');
    }
    if (listEl && fallback.length) {
      _allUpdates = fallback;
      applyFilters();
    }
  }

  // ── Initial data load ─────────────────────────────────────────────────────
  async function loadUpdates() {
    const listEl = document.getElementById('updates-list');
    listEl.innerHTML = spinner();
    try {
      _allUpdates = normaliseUpdatesResponse(await fetchUpdates({}));
      renderHomepageRails(_allUpdates);
      applyFilters();
    } catch (err) {
      renderOfflineRails(`Live patch feed is reconnecting: ${err.message}`);
    }
  }

  function renderHomepageRails(updates) {
    const featureGrid = document.getElementById('dash-feature-grid');
    const radarGrid   = document.getElementById('dash-radar-grid');
    if (!featureGrid || !radarGrid) return;

    const newest = [...updates].sort((a, b) => new Date(b.releasedAt) - new Date(a.releasedAt));
    const servicePlatforms = new Set(['Steam', 'Discord', 'BattleNet', 'GOG', 'Switch', 'PS5', 'Xbox', 'Epic']);
    const pcPlatforms = new Set(['AMD', 'NVIDIA', 'Intel', 'Windows', 'Apple', 'macOS']);

    const featured = newest.slice(0, 3);
    const services = newest.filter((u) => servicePlatforms.has(u.platform)).slice(0, 3);
    const pcStack  = newest.filter((u) => pcPlatforms.has(u.platform)).slice(0, 3);
    const caution  = newest.filter((u) => u.status !== 'stable').slice(0, 3);
    const best = [...updates].sort((a, b) => b.score - a.score)[0];
    const riskiest = [...updates].sort((a, b) => a.score - b.score)[0];

    const tapeTrack = document.getElementById('update-tape-track');
    if (tapeTrack) {
      const tapeItems = newest.length ? [...newest, ...newest, ...newest] : [];
      tapeTrack.innerHTML = tapeItems.length
        ? tapeItems.map((u) => {
            const d = decisionForUpdate(u);
            const delta = u.status === 'stable' ? '↑' : u.status === 'avoid' ? '↓' : '•';
            return `<a class="update-tape-item update-tape-item--${H(d.cls)}" href="#/update/${H(u.id)}"><b>${H(platformLabel(u.platform))}</b><span>${H(String(u.score))}</span><em>${H(d.action)} ${delta}</em></a>`;
          }).join('')
        : '<span class="update-tape-empty">Loading tracked updates…</span>';
    }

    const compareStrip = document.getElementById('compare-strip');
    if (compareStrip) {
      compareStrip.innerHTML = [
        renderCompareCard('Highest confidence', best),
        renderCompareCard('Needs patience', riskiest),
      ].join('');
    }

    featureGrid.innerHTML = featured.length
      ? featured.map((u) => renderMiniUpdateCard(u)).join('')
      : '<p class="dash-empty-copy">No featured updates available yet.</p>';

    radarGrid.innerHTML = [
      renderRadarCard('Apps and consoles', 'Launchers, storefronts, handhelds, and console updates.', services),
      renderRadarCard('PC essentials', 'Drivers and operating system updates that can change performance.', pcStack),
      renderRadarCard('Slow down first', 'Recent releases with caution signs, bug reports, or avoid ratings.', caution),
    ].join('');

    const reviewed = [...updates]
      .filter(u => u.userRating)
      .sort((a, b) => (b.userRating?.totalVotes || 0) - (a.userRating?.totalVotes || 0))[0] || newest[0];
    const meta = peerRatingMeta(reviewed);
    const scoreEl = document.getElementById('peer-rating-score');
    const labelEl = document.getElementById('peer-rating-label');
    const updateEl = document.getElementById('peer-rating-update');
    const noteEl = document.getElementById('peer-rating-note');
    const installEl = document.getElementById('peer-install');
    const waitEl = document.getElementById('peer-wait');
    const avoidEl = document.getElementById('peer-avoid');
    const installBar = document.getElementById('peer-install-bar');
    const waitBar = document.getElementById('peer-wait-bar');
    const avoidBar = document.getElementById('peer-avoid-bar');

    if (scoreEl) scoreEl.textContent = meta.score ? meta.score.toFixed(1) : '—';
    if (labelEl) labelEl.textContent = meta.label;
    if (updateEl) updateEl.textContent = reviewed ? `${reviewed.name} · ${platformLabel(reviewed.platform)}` : 'Latest update confidence';
    if (noteEl) noteEl.textContent = meta.votes ? `Based on ${meta.votes.toLocaleString()} user votes and bug reports.` : 'No user votes yet. Showing patch notes and source review only.';
    if (installEl) installEl.textContent = `${meta.install}%`;
    if (waitEl) waitEl.textContent = `${meta.wait}%`;
    if (avoidEl) avoidEl.textContent = `${meta.avoid}%`;
    if (installBar) installBar.style.width = `${meta.install}%`;
    if (waitBar) waitBar.style.width = `${meta.wait}%`;
    if (avoidBar) avoidBar.style.width = `${meta.avoid}%`;
  }

  // ── Hero stats from summary ───────────────────────────────────────────────
  fetchSummary().then(res => {
    const d = res?.data || res;
    if (!d) return;
    const stable  = document.getElementById('stat-stable');
    const caution = document.getElementById('stat-caution');
    const avoid   = document.getElementById('stat-avoid');
    if (stable)  stable.textContent  = d.stable  ?? '—';
    if (caution) caution.textContent = d.caution ?? '—';
    if (avoid)   avoid.textContent   = d.avoid   ?? '—';
  }).catch(() => {});

  // ── Setup lens buttons ─────────────────────────────────────────────────────
  document.querySelectorAll('.setup-lens').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.setup-lens').forEach(b => b.classList.toggle('active', b === btn));
      _filterState.search = btn.dataset.lens || '';
      _filterState.platform = '';
      document.querySelectorAll('#platform-filters .chip').forEach(b =>
        b.classList.toggle('active', b.dataset.platform === '')
      );
      const searchEl = document.getElementById('dash-search');
      if (searchEl) searchEl.value = btn.dataset.label === 'Everything' ? '' : btn.dataset.label;
      document.getElementById('dash-search-clear')?.classList.toggle('hidden', !btn.dataset.lens);
      applyFilters();
    });
  });

  // ── Platform chip buttons ─────────────────────────────────────────────────
  document.querySelectorAll('#platform-filters .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      _filterState.platform = btn.dataset.platform;
      document.querySelectorAll('#platform-filters .chip').forEach(b =>
        b.classList.toggle('active', b.dataset.platform === _filterState.platform)
      );
      applyFilters();
    });
  });


  // ── Pro: Follow my games ──────────────────────────────────────────────────
  function renderFollowedGames() {
    const suggestionsEl = document.getElementById('follow-game-suggestions');
    const followedEl = document.getElementById('followed-games');
    if (!suggestionsEl || !followedEl) return;
    const followed = getFollowedSteamGames();
    const followedIds = new Set(followed.map(g => g.appId));
    suggestionsEl.innerHTML = FOLLOWABLE_STEAM_GAMES.map(g => `
      <button class="follow-game-chip ${followedIds.has(g.appId) ? 'active' : ''}" data-app-id="${H(g.appId)}">${H(g.name)}</button>
    `).join('');
    followedEl.innerHTML = followed.length
      ? followed.map(g => `
          <div class="followed-game-card" data-app-id="${H(g.appId)}">
            <div><strong>${H(g.name)}</strong><span>Steam App ${H(g.appId)}</span></div>
            <button class="followed-game-filter" data-game="${H(g.name)}">Filter feed</button>
            <button class="followed-game-remove" aria-label="Remove ${H(g.name)}">×</button>
          </div>
        `).join('')
      : '<p class="follow-games-empty">No followed games yet. Add a Steam game to make this feed yours.</p>';
  }

  function addFollowedGame(game) {
    if (!game?.name) return;
    const followed = getFollowedSteamGames();
    if (!followed.some(g => g.appId === game.appId)) {
      followed.push({ appId: game.appId, name: game.name, tags: game.tags || game.name.toLowerCase() });
      setFollowedSteamGames(followed);
    }
    renderFollowedGames();
  }

  renderFollowedGames();
  document.getElementById('follow-game-add')?.addEventListener('click', () => {
    const input = document.getElementById('follow-game-input');
    const game = findSteamGame(input?.value || '');
    if (game) addFollowedGame(game);
    if (input) input.value = '';
  });
  document.getElementById('follow-game-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('follow-game-add')?.click();
    }
  });
  document.getElementById('follow-game-suggestions')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-app-id]');
    if (!chip) return;
    const game = FOLLOWABLE_STEAM_GAMES.find(g => g.appId === chip.dataset.appId);
    addFollowedGame(game);
  });
  document.getElementById('followed-games')?.addEventListener('click', (e) => {
    const card = e.target.closest('.followed-game-card');
    if (!card) return;
    if (e.target.closest('.followed-game-remove')) {
      setFollowedSteamGames(getFollowedSteamGames().filter(g => g.appId !== card.dataset.appId));
      renderFollowedGames();
      return;
    }
    const filterBtn = e.target.closest('.followed-game-filter');
    if (filterBtn) {
      _filterState.search = filterBtn.dataset.game || '';
      const searchEl = document.getElementById('dash-search');
      if (searchEl) searchEl.value = _filterState.search;
      document.getElementById('dash-search-clear')?.classList.remove('hidden');
      applyFilters();
    }
  });

  // ── Status chip buttons ───────────────────────────────────────────────────
  document.querySelectorAll('#status-filters .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      _filterState.status = btn.dataset.status;
      document.querySelectorAll('#status-filters .chip').forEach(b =>
        b.classList.toggle('active', b.dataset.status === _filterState.status)
      );
      applyFilters();
    });
  });

  // ── Sort dropdown ─────────────────────────────────────────────────────────
  document.getElementById('dash-sort')?.addEventListener('change', (e) => {
    _filterState.sort = e.target.value;
    applyFilters();
  });

  // ── Search input (debounced 250ms) ────────────────────────────────────────
  let _searchTimer = null;
  const searchEl   = document.getElementById('dash-search');
  const clearBtn   = document.getElementById('dash-search-clear');

  searchEl?.addEventListener('input', (e) => {
    const val = e.target.value;
    clearBtn?.classList.toggle('hidden', !val);
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      _filterState.search = val.trim();
      applyFilters();
    }, 250);
  });

  clearBtn?.addEventListener('click', () => {
    if (searchEl) searchEl.value = '';
    clearBtn.classList.add('hidden');
    _filterState.search = '';
    applyFilters();
  });

  // ── Clear all ─────────────────────────────────────────────────────────────
  document.getElementById('dash-clear-all')?.addEventListener('click', clearAllFilters);

  loadUpdates();

  // ── Live community feed ───────────────────────────────────────────────────
  (function initFeed() {
    const messagesEl = document.getElementById('feed-messages');
    const inputEl    = document.getElementById('feed-input');
    const sendBtn    = document.getElementById('feed-send');
    const dotEl      = document.getElementById('feed-dot');
    if (!messagesEl) return;

    let   _sseClose    = null;
    let   _autoScroll  = true;   // pause scroll when user scrolls up
    const MAX_MESSAGES = 80;     // cap DOM nodes to keep it light

    // Detect scroll intent to pause auto-scroll
    messagesEl.addEventListener('scroll', () => {
      const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
      _autoScroll = atBottom;
    });

    function scrollToBottom() {
      if (_autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function avatarLetter(email) {
      return (email || '?')[0].toUpperCase();
    }

    function formatTime(iso) {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function platformBadge(platform) {
      if (!platform) return '';
      const suffix = PLATFORM_CLASS[platform] || 'default';
      return `<span class="feed-platform-tag platform--${suffix}">${H(platformLabel(platform))}</span>`;
    }

    function appendMessage(post, animate = true) {
      const isOwn    = post.userEmail === getUser()?.email;
      const letter   = avatarLetter(post.userEmail);
      const el       = document.createElement('div');
      el.className   = `feed-msg${animate ? ' feed-msg--in' : ''}${isOwn ? ' feed-msg--own' : ''}`;
      el.dataset.id  = post.id;
      el.innerHTML   = `
        <div class="feed-msg-avatar">${H(letter)}</div>
        <div class="feed-msg-content">
          <div class="feed-msg-meta">
            <span class="feed-msg-name">${H(post.userEmail.split('@')[0])}</span>
            ${platformBadge(post.platform)}
            <span class="feed-msg-time">${formatTime(post.createdAt)}</span>
          </div>
          <div class="feed-msg-body">${H(post.body)}</div>
        </div>
      `;
      messagesEl.appendChild(el);

      // Trim to MAX_MESSAGES
      while (messagesEl.children.length > MAX_MESSAGES) {
        messagesEl.removeChild(messagesEl.firstChild);
      }

      scrollToBottom();
    }

    function setStatus(status) {
      // status: 'connecting' | 'live' | 'error'
      if (!dotEl) return;
      dotEl.className   = `feed-dot feed-dot--${status}`;
      dotEl.title       = { connecting: 'Connecting…', live: 'Live', error: 'Reconnecting…' }[status] || '';
    }

    // Load historical posts first
    async function loadHistory() {
      try {
      const posts = await fetchRecentPosts();
        if (posts.length === 0) {
          const empty = document.createElement('div');
          empty.className   = 'feed-empty';
          empty.textContent = 'No posts yet. Be the first.';
          messagesEl.appendChild(empty);
        } else {
          posts.forEach(p => appendMessage(p, false));
        }
      } catch {
        /* non-fatal — SSE will deliver new posts regardless */
      }
    }

    // Open SSE stream
    function connectSSE() {
      if (_sseClose) _sseClose();
      setStatus('connecting');

      const token = window.__feedToken__;
      if (!token) { setStatus('live'); return; }

      _sseClose = openFeedStream(
        token,
        (post) => {
          // Deduplicate: skip if already in DOM (from history load)
          if (messagesEl.querySelector(`[data-id="${post.id}"]`)) return;
          // Remove empty state
          messagesEl.querySelector('.feed-empty')?.remove();
          appendMessage(post, true);
          setStatus('live');
        },
        () => {
          setStatus('error');
          // Reconnect after 5s
          setTimeout(connectSSE, 5000);
        }
      );

      // Mark live once the connection is established
      setTimeout(() => {
        if (dotEl?.classList.contains('feed-dot--connecting')) setStatus('live');
      }, 1500);
    }

    // Send a post
    async function sendPost() {
      const body = inputEl?.value.trim();
      if (!body || body.length === 0) return;

      sendBtn.disabled  = true;
      inputEl.disabled  = true;

      try {
        await submitPost({ body });
        inputEl.value = '';
      } catch (err) {
        showToast(err.message || 'Failed to post', 'error');
      } finally {
        sendBtn.disabled  = false;
        inputEl.disabled  = false;
        inputEl.focus();
      }
    }

    sendBtn?.addEventListener('click', sendPost);
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPost(); }
    });

    loadHistory().then(connectSSE);
  })();

  // Bug report form (Pro only)
  const bugForm = document.getElementById('bug-form');
  if (bugForm) {
    const bugError  = document.getElementById('bug-error');
    const bugSubmit = document.getElementById('bug-submit');

    bugForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      bugError.classList.add('hidden');
      bugSubmit.disabled = true;
      bugSubmit.textContent = 'Submitting…';

      try {
        const updateId    = document.getElementById('bug-update').value.trim();
        const severity    = document.getElementById('bug-severity').value;
        const description = document.getElementById('bug-desc').value.trim();
        await submitBugReport({ updateId, severity, description });
        showToast('Bug report submitted!', 'success');
        bugForm.reset();
      } catch (err) {
        bugError.textContent = err.message;
        bugError.classList.remove('hidden');
      } finally {
        bugSubmit.disabled = false;
        bugSubmit.textContent = 'Submit report';
      }
    });
  }
}

// ── TICKER / sidebar ──────────────────────────────────────────────────────────
// (Pro feature — omitted from free tier; shown as locked in dashboard)

// ── BOOT ──────────────────────────────────────────────────────────────────────
// ── UPDATE DETAIL PAGE ────────────────────────────────────────────────────────
async function renderUpdateDetail(id) {
  const user = getUser(); // null for guests — page is public

  setHTML(`
    ${renderNav(user)}
    <div class="detail-page">
      <div class="detail-loading">${spinner()}</div>
    </div>
  `);
  attachNavHandlers(user);

  let u;
  try {
    u = await fetchUpdateById(id);
  } catch (err) {
    setHTML(`
      ${renderNav(user)}
      <div class="detail-page">
        <div class="detail-error">
          <div class="detail-error-code">Error</div>
          <p>${H(err.message)}</p>
          <a class="btn btn--outline" href="#/updates">← Back to dashboard</a>
        </div>
      </div>
    `);
    attachNavHandlers(user);
    return;
  }

  if (!u) {
    setHTML(`
      ${renderNav(user)}
      <div class="detail-page">
        <div class="detail-error">
          <div class="detail-error-code">404</div>
          <p>Update not found.</p>
          <a class="btn btn--outline" href="#/updates">← Back to dashboard</a>
        </div>
      </div>
    `);
    attachNavHandlers(user);
    return;
  }

  const pSuffix   = platformSuffix(u.platform);
  const color     = scoreColor(u.score);
  const scorePct  = Math.round((u.score / 10) * 100);

  const riskLevelIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };

  // ── Impact Score bar ──────────────────────────────────────────────────────
  const impactScore  = u.impactScore ?? null;
  const impactColor  = impactScore !== null ? scoreColor(impactScore) : '#555';
  const impactPct    = impactScore !== null ? Math.round((impactScore / 10) * 100) : 0;
  const impactLabel  = impactScore === null ? '—'
    : impactScore >= 8 ? 'High Impact' : impactScore >= 5 ? 'Moderate Impact' : 'Low Impact';

  // ── Security Criticality ──────────────────────────────────────────────────
  const sec = u.securityCriticality || { level: 'none', label: 'No Data', cves: [] };
  const secColors = {
    critical: { bg: 'rgba(248,113,113,.08)', border: 'rgba(248,113,113,.35)', text: '#f87171', badge: '#7f1d1d' },
    high:     { bg: 'rgba(251,146,60,.08)',  border: 'rgba(251,146,60,.35)',  text: '#fb923c', badge: '#7c2d12' },
    medium:   { bg: 'rgba(251,191,36,.06)',  border: 'rgba(251,191,36,.25)',  text: '#fbbf24', badge: '#713f12' },
    low:      { bg: 'rgba(74,222,128,.05)',  border: 'rgba(74,222,128,.2)',   text: '#4ade80', badge: '#14532d' },
    none:     { bg: 'rgba(85,85,85,.08)',    border: 'rgba(85,85,85,.2)',     text: '#888',    badge: '#222' },
  };
  const secC = secColors[sec.level] || secColors.none;
  const secIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢', none: '⚪' }[sec.level] || '⚪';
  const cveHTML = (sec.cves || []).map(c =>
    `<span class="detail-cve-tag">${H(c)}</span>`
  ).join('');

  // ── User Rating (live from API, falls back to static) ────────────────────────
  const ur = u.userRating || null;
  const userVote = u.userVote || null;        // voter's current choice from server
  const ratingsLive = u.ratingsLive || false; // true = real DB votes, false = static

  function ratingHTML(r, currentVote) {
    if (!r) return '<p class="detail-empty-note">No user ratings yet. Be the first to vote!</p>';
    const urColor     = scoreColor(r.score ?? 5);
    const starFill    = r.score != null ? Math.round((r.score / 10) * 5 * 10) / 10 : 0;
    const stars = [1,2,3,4,5].map(i => {
      const fill = Math.min(1, Math.max(0, starFill - (i - 1)));
      if (fill >= 1) return `<span class="detail-star detail-star--full">★</span>`;
      if (fill > 0)  return `<span class="detail-star detail-star--half">★</span>`;
      return `<span class="detail-star detail-star--empty">☆</span>`;
    }).join('');
    return `
      <div class="detail-rating-card">
        <div class="detail-rating-top">
          <div class="detail-rating-score" style="color:${urColor}">${(r.score ?? '—').toString()}</div>
          <div class="detail-rating-stars">${stars}</div>
          <div class="detail-rating-count">${(r.totalVotes || 0).toLocaleString()} votes${ratingsLive ? ' <span class="rating-live-dot">●</span>' : ''}</div>
        </div>
        <div class="detail-rating-bars">
          <div class="detail-rating-row">
            <span class="detail-rating-label" style="color:var(--green)">Install</span>
            <div class="detail-rating-track"><div class="detail-rating-fill" style="width:${r.breakdown?.install ?? 0}%;background:var(--green)"></div></div>
            <span class="detail-rating-pct">${r.breakdown?.install ?? 0}%</span>
          </div>
          <div class="detail-rating-row">
            <span class="detail-rating-label" style="color:var(--yellow)">Wait</span>
            <div class="detail-rating-track"><div class="detail-rating-fill" style="width:${r.breakdown?.wait ?? 0}%;background:var(--yellow)"></div></div>
            <span class="detail-rating-pct">${r.breakdown?.wait ?? 0}%</span>
          </div>
          <div class="detail-rating-row">
            <span class="detail-rating-label" style="color:var(--red)">Avoid</span>
            <div class="detail-rating-track"><div class="detail-rating-fill" style="width:${r.breakdown?.avoid ?? 0}%;background:var(--red)"></div></div>
            <span class="detail-rating-pct">${r.breakdown?.avoid ?? 0}%</span>
          </div>
        </div>
      </div>`;
  }

  const urBarInstall = ur ? ur.breakdown?.install ?? 0 : 0;
  const urBarWait    = ur ? ur.breakdown?.wait    ?? 0 : 0;
  const urBarAvoid   = ur ? ur.breakdown?.avoid   ?? 0 : 0;

  const riskHTML = (u.riskFactors || []).map(r => `
    <div class="detail-risk-item detail-risk--${H(r.level)}">
      <span class="detail-risk-icon">${riskLevelIcon[r.level] || '⚪'}</span>
      <div>
        <span class="detail-risk-level">${H(r.level.toUpperCase())}</span>
        <span class="detail-risk-text">${H(r.text)}</span>
      </div>
    </div>
  `).join('');

  const evidenceHTML = (u.evidence || []).map(e => `
    <a class="detail-evidence-item" href="${H(e.url)}" target="_blank" rel="noopener">
      <span class="detail-evidence-source">${H(e.source)}</span>
      <span class="detail-evidence-text">${H(e.text)}</span>
      <span class="detail-evidence-arrow">↗</span>
    </a>
  `).join('');

  const changelogHTML = (u.changelog || []).map(c => `
    <li class="detail-list-item detail-list-item--positive">
      <span class="detail-list-marker">+</span>${H(c)}
    </li>
  `).join('');

  const issuesHTML = (u.knownIssues || []).length
    ? (u.knownIssues).map(i => `
        <li class="detail-list-item detail-list-item--negative">
          <span class="detail-list-marker">!</span>${H(i)}
        </li>
      `).join('')
    : '<li class="detail-list-item detail-list-item--none"><span class="detail-list-marker">✓</span>No known issues reported</li>';

  const feedHTML = (u.feed || []).slice(0, 5).map(p => `
    <a class="detail-feed-item" href="${H(p.url)}" target="_blank" rel="noopener">
      <div class="detail-feed-meta">
        <span class="detail-feed-source">${H(p.source)}</span>
        <span class="detail-feed-score">▲ ${H(String(p.score))}</span>
      </div>
      <div class="detail-feed-title">${H(p.title)}</div>
    </a>
  `).join('') || '<p class="detail-feed-empty">No community posts loaded.</p>';

  setHTML(`
    ${renderNav(user)}
    <div class="detail-page">

      <!-- Breadcrumb -->
      <div class="detail-breadcrumb">
        <a href="#/updates" class="detail-back">← Dashboard</a>
        <span class="detail-breadcrumb-sep">/</span>
        <span class="text-platform--${pSuffix}">${H(platformLabel(u.platform))}</span>
        <span class="detail-breadcrumb-sep">/</span>
        <span>${H(u.name)}</span>
      </div>

      <!-- Hero -->
      <div class="detail-hero">
        <div class="detail-hero-left">
          <div class="update-platform-icon platform--${pSuffix} detail-platform-icon">
            ${H(PLATFORM_SHORT[u.platform] ?? u.platform.slice(0,3).toUpperCase())}
          </div>
          <div>
            <h1 class="detail-title">${H(u.name)}</h1>
            <div class="detail-meta">
              <span class="text-platform--${pSuffix}">${H(platformLabel(u.platform))}</span>
              <span class="detail-meta-sep">·</span>
              <span>v${H(u.version)}</span>
              <span class="detail-meta-sep">·</span>
              <span>Released ${H(u.releasedAt)}</span>
              <span class="detail-meta-sep">·</span>
              <span>${H(u.affects)}</span>
            </div>
          </div>
        </div>

        <!-- Score metrics block — Safety / Impact / Security -->
        <div class="detail-score-block">

          <!-- Safety Score -->
          <div class="detail-metric-group">
            <div class="detail-score-bar-wrap">
              <div class="detail-score-track">
                <div class="detail-score-labels">
                  <span>10</span><span>8</span><span>6</span><span>4</span><span>2</span><span>0</span>
                </div>
                <div class="detail-score-column">
                  <div class="detail-score-empty"></div>
                  <div class="detail-score-fill"
                       style="height:${scorePct}%;background:linear-gradient(to top,${color},${color}88);box-shadow:0 0 16px ${color}44">
                  </div>
                </div>
              </div>
              <div>
                <div class="detail-score-number" style="color:${color}">${H(String(u.score))}</div>
                <div class="detail-score-caption">Safety</div>
              </div>
            </div>
          </div>

          <!-- Impact Score -->
          <div class="detail-metric-group">
            <div class="detail-score-bar-wrap">
              <div class="detail-score-track">
                <div class="detail-score-labels">
                  <span>10</span><span>8</span><span>6</span><span>4</span><span>2</span><span>0</span>
                </div>
                <div class="detail-score-column">
                  <div class="detail-score-empty"></div>
                  <div class="detail-score-fill"
                       style="height:${impactPct}%;background:linear-gradient(to top,${impactColor},${impactColor}88);box-shadow:0 0 16px ${impactColor}44">
                  </div>
                </div>
              </div>
              <div>
                <div class="detail-score-number" style="color:${impactColor}">${impactScore !== null ? H(String(impactScore)) : '—'}</div>
                <div class="detail-score-caption">Impact</div>
              </div>
            </div>
          </div>

          <div class="detail-score-meta">
            <div class="status-badge ${H(u.status)} detail-status-badge">${H(u.status.toUpperCase())}</div>
            <div class="detail-impact-label" style="color:${impactColor}">${H(impactLabel)}</div>
            <div class="detail-bug-count">🐛 ${H(String(u.bugCount))} reports</div>
          </div>

        </div>
      </div>

      <!-- Verdict banner -->
      <div class="detail-verdict detail-verdict--${H(u.status)}">
        <span class="detail-verdict-label">TAKEAWAY</span>
        <p class="detail-verdict-text">${H(u.verdict || 'No takeaway available for this update yet.')}</p>
      </div>

      <!-- Main content grid -->
      <div class="detail-grid">

        <!-- Left col: Reasoning + Changelog + Issues -->
        <div class="detail-col-main">

          <section class="detail-section">
            <h2 class="detail-section-title">What we found</h2>
            <p class="detail-reasoning">${H(u.reasoning || 'Our notes for this update are not published yet. Check back after the community monitoring window, typically 72 hours after release.')}</p>
          </section>

          <section class="detail-section">
            <h2 class="detail-section-title">Changelog</h2>
            <ul class="detail-list">${changelogHTML || '<li class="detail-list-item detail-list-item--none"><span class="detail-list-marker">—</span>No changelog available</li>'}</ul>
          </section>

          <section class="detail-section">
            <h2 class="detail-section-title">Known Issues</h2>
            <ul class="detail-list">${issuesHTML}</ul>
          </section>

        </div>

        <!-- Right col: Security Criticality + User Rating + Risk factors + Evidence + Community feed -->
        <div class="detail-col-side">

          <!-- Security Criticality -->
          <section class="detail-section">
            <h2 class="detail-section-title">Security Criticality</h2>
            <div class="detail-security-card" style="background:${secC.bg};border-color:${secC.border}">
              <div class="detail-security-header">
                <span class="detail-security-icon">${secIcon}</span>
                <span class="detail-security-level" style="color:${secC.text}">${H(sec.level.toUpperCase())}</span>
                <span class="detail-security-label">${H(sec.label)}</span>
              </div>
              ${cveHTML ? `<div class="detail-cve-list">${cveHTML}</div>` : ''}
            </div>
          </section>

          ${ur?.totalVotes ? `
          <section class="detail-section">
            <h2 class="detail-section-title">User Rating
              ${ratingsLive ? '<span class="section-title-badge section-title-badge--live">LIVE</span>' : ''}
            </h2>
            <div id="rating-display">${ratingHTML(ur, userVote)}</div>
            ${isLoggedIn() ? `
            <div class="detail-vote-bar" id="vote-bar">
              <span class="detail-vote-label">Your vote:</span>
              <button class="vote-btn vote-btn--install ${userVote === 'install' ? 'active' : ''}" data-vote="install">✓ Install</button>
              <button class="vote-btn vote-btn--wait   ${userVote === 'wait'    ? 'active' : ''}" data-vote="wait">⏳ Wait</button>
              <button class="vote-btn vote-btn--avoid  ${userVote === 'avoid'   ? 'active' : ''}" data-vote="avoid">✗ Avoid</button>
              ${userVote ? `<button class="vote-btn vote-btn--retract" data-retract>Clear</button>` : ''}
            </div>` : `<p class="detail-vote-cta"><a href="#/login">Sign in</a> to cast your vote</p>`}
          </section>` : ''}

          <section class="detail-section">
            <h2 class="detail-section-title">Risk Factors</h2>
            <div class="detail-risk-list">
              ${riskHTML || '<p class="detail-empty-note">No specific risk factors recorded.</p>'}
            </div>
          </section>

          <section class="detail-section">
            <h2 class="detail-section-title">Sources</h2>
            <div class="detail-evidence-list">
              ${evidenceHTML || '<p class="detail-empty-note">No evidence sources recorded yet.</p>'}
            </div>
          </section>

          <section class="detail-section">
            <h2 class="detail-section-title">Community discussion</h2>
            <div class="detail-feed">${feedHTML}</div>
          </section>

          <section class="detail-section">
            <h2 class="detail-section-title">Community Bug Reports
              <span class="section-title-badge section-title-badge--live">LIVE</span>
            </h2>
            <div id="detail-bug-feed">
              <div class="detail-loading-inline">${spinner()}</div>
            </div>
          </section>

        </div>
      </div>

    </div>
  `);
  attachNavHandlers(user);

  // ── Load live bug reports ─────────────────────────────────────────────────
  const bugFeedEl = document.getElementById('detail-bug-feed');
  if (bugFeedEl) {
    try {
      const { fetchBugReports } = await import('./api.js');
      const bugRes  = await fetchBugReports(u.id);
      const reports = bugRes.data || [];
      renderBugFeed(bugFeedEl, reports, u.id);
    } catch (err) {
      bugFeedEl.innerHTML = '<p class="detail-empty-note">Bug reports unavailable.</p>';
    }
  }

  // ── Live vote handlers ────────────────────────────────────────────────────
  const voteBar = document.getElementById('vote-bar');
  if (voteBar) {
    voteBar.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-vote],[data-retract]');
      if (!btn) return;

      const isRetract = btn.hasAttribute('data-retract');
      const vote      = btn.dataset.vote;

      // Optimistic: disable bar
      voteBar.querySelectorAll('button').forEach(b => b.disabled = true);

      try {
        const { castVote: apiCastVote, retractVote: apiRetractVote } = await import('./api.js');
        const result = isRetract
          ? await apiRetractVote(u.id)
          : await apiCastVote(u.id, vote);

        // Update display with fresh aggregated data
        const displayEl = document.getElementById('rating-display');
        if (displayEl && result?.data) {
          displayEl.innerHTML = ratingHTML(result.data, isRetract ? null : vote);
        }

        // Rebuild vote bar to reflect new state
        const newVote = isRetract ? null : vote;
        voteBar.innerHTML = `
          <span class="detail-vote-label">Your vote:</span>
          <button class="vote-btn vote-btn--install ${newVote === 'install' ? 'active' : ''}" data-vote="install">✓ Install</button>
          <button class="vote-btn vote-btn--wait   ${newVote === 'wait'    ? 'active' : ''}" data-vote="wait">⏳ Wait</button>
          <button class="vote-btn vote-btn--avoid  ${newVote === 'avoid'   ? 'active' : ''}" data-vote="avoid">✗ Avoid</button>
          ${newVote ? `<button class="vote-btn vote-btn--retract" data-retract>Clear</button>` : ''}
        `;
      } catch (err) {
        showToast(err.message || 'Vote failed. Please try again.', 'error');
        voteBar.querySelectorAll('button').forEach(b => b.disabled = false);
      }
    });
  }
}


// ── ACCOUNT SETTINGS ─────────────────────────────────────────────────────────
async function renderAccount() {
  if (!isLoggedIn()) { navigate('/login'); return; }
  const user = getUser();

  setHTML(`
    ${renderNav(user)}
    <div class="account-page">
      <div class="account-header">
        <h1 class="account-title">Account Settings</h1>
        <p class="account-subtitle">${H(user.email)}</p>
      </div>
      <div class="account-grid">

        <!-- LEFT: Profile + Password -->
        <div class="account-col">

          <section class="account-section">
            <h2 class="account-section-title">Profile</h2>
            <div class="account-info-row"><span class="account-info-label">Email</span><span class="account-info-value">${H(user.email)}</span></div>
            <div class="account-info-row"><span class="account-info-label">Plan</span><span class="account-info-value"><span class="nav-role nav-role--${user.role}">${user.role.toUpperCase()}</span></span></div>
            <div class="account-info-row" id="sub-info-row"><span class="account-info-label">Subscription</span><span class="account-info-value" id="sub-info">${spinner()}</span></div>
            ${user.role === 'pro' || user.role === 'admin' ? `
            <button class="btn btn--outline btn--sm account-portal-btn" id="billing-portal-btn">Manage billing →</button>` : `
            <a class="btn btn--primary btn--sm" href="#/pricing">Upgrade to Pro</a>`}
          </section>

          <section class="account-section">
            <h2 class="account-section-title">Change Password</h2>
            <div id="pw-success" class="account-alert account-alert--success hidden">Password updated.</div>
            <div id="pw-error"   class="account-alert account-alert--error   hidden"></div>
            <div class="account-field">
              <label class="account-label">Current password</label>
              <input class="field-input" id="pw-current" type="password" autocomplete="current-password" />
            </div>
            <div class="account-field">
              <label class="account-label">New password</label>
              <input class="field-input" id="pw-new" type="password" autocomplete="new-password" />
            </div>
            <div class="account-field">
              <label class="account-label">Confirm new password</label>
              <input class="field-input" id="pw-confirm" type="password" autocomplete="new-password" />
            </div>
            <button class="btn btn--primary btn--sm" id="pw-save">Update password</button>
          </section>

        </div>

        <!-- RIGHT: Watchlist + Webhooks (Pro) -->
        <div class="account-col">

          <section class="account-section">
            <h2 class="account-section-title">
              Platform Watchlist
              ${user.role !== 'pro' && user.role !== 'admin' ? '<span class="account-pro-badge">PRO</span>' : ''}
            </h2>
            <p class="account-section-desc">Get emailed when a new update drops for platforms you watch.</p>
            ${user.role === 'pro' || user.role === 'admin' ? `
            <div id="watchlist-grid" class="watchlist-grid">${spinner()}</div>
            ` : `<div class="account-upsell">
              <p>Upgrade to Pro to subscribe to platform alerts.</p>
              <a class="btn btn--primary btn--sm" href="#/pricing">Upgrade →</a>
            </div>`}
          </section>

          ${user.role === 'pro' || user.role === 'admin' ? `
          <section class="account-section">
            <h2 class="account-section-title">Webhook / Slack Integration <span class="account-pro-badge">PRO</span></h2>
            <p class="account-section-desc">Receive update alerts directly in Slack or your own endpoint.</p>
            <div id="webhook-error" class="account-alert account-alert--error hidden"></div>
            <div id="webhook-success" class="account-alert account-alert--success hidden">Settings saved.</div>
            <div class="account-field">
              <label class="account-label">Slack Incoming Webhook URL</label>
              <input class="field-input" id="wh-slack" type="url" placeholder="https://hooks.slack.com/services/…" />
            </div>
            <div class="account-field">
              <label class="account-label">Custom Webhook URL (generic JSON)</label>
              <input class="field-input" id="wh-custom" type="url" placeholder="https://your-endpoint.example.com/hooks" />
            </div>
            <div class="account-field account-field--inline">
              <input type="checkbox" id="wh-enabled" checked />
              <label class="account-label" for="wh-enabled">Webhooks enabled</label>
            </div>
            <button class="btn btn--primary btn--sm" id="wh-save">Save webhook settings</button>
          </section>
          ` : ''}

        </div>
      </div>
    </div>
  `);
  attachNavHandlers(user);

  // ── Load subscription info ────────────────────────────────────────────────
  try {
    const { fetchAccountMe } = await import('./api.js');
    const me = await fetchAccountMe();
    const sub = me.data?.subscription;
    const subEl = document.getElementById('sub-info');
    if (subEl) {
      subEl.textContent = sub
        ? `${sub.status.toUpperCase()} · renews ${new Date(sub.current_period_end).toLocaleDateString()}`
        : 'No active subscription';
    }
  } catch { /* DB may not be available */ }

  // ── Password change ───────────────────────────────────────────────────────
  document.getElementById('pw-save')?.addEventListener('click', async () => {
    const btn       = document.getElementById('pw-save');
    const errEl     = document.getElementById('pw-error');
    const okEl      = document.getElementById('pw-success');
    errEl.classList.add('hidden');
    okEl.classList.add('hidden');

    const currentPassword = document.getElementById('pw-current').value;
    const newPassword     = document.getElementById('pw-new').value;
    const confirmPassword = document.getElementById('pw-confirm').value;

    if (!currentPassword || !newPassword) { errEl.textContent = 'All fields are required.'; errEl.classList.remove('hidden'); return; }
    if (newPassword !== confirmPassword) { errEl.textContent = 'New passwords do not match.'; errEl.classList.remove('hidden'); return; }

    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { changePassword } = await import('./api.js');
      await changePassword({ currentPassword, newPassword, confirmPassword });
      okEl.classList.remove('hidden');
      document.getElementById('pw-current').value = '';
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-confirm').value = '';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally { btn.disabled = false; btn.textContent = 'Update password'; }
  });

  // ── Billing portal ────────────────────────────────────────────────────────
  document.getElementById('billing-portal-btn')?.addEventListener('click', async () => {
    try {
      const { openBillingPortal } = await import('./api.js');
      const { url } = await openBillingPortal();
      window.location.href = url;
    } catch (err) { showToast(err.message, 'error'); }
  });

  if (user.role !== 'pro' && user.role !== 'admin') return;

  // ── Load watchlist ────────────────────────────────────────────────────────
  const ALL_PLATFORMS = TRACKED_PLATFORMS;
  let watchlist = [];
  try {
    const { fetchWatchlist } = await import('./api.js');
    const res = await fetchWatchlist();
    watchlist = res.data || [];
  } catch { /* unavailable */ }

  const watchlistGrid = document.getElementById('watchlist-grid');
  if (watchlistGrid) {
    const watchedSet = new Set(watchlist.map(w => w.platform));
    watchlistGrid.innerHTML = ALL_PLATFORMS.map(p => `
      <div class="watchlist-item ${watchedSet.has(p) ? 'watchlist-item--active' : ''}" data-platform="${H(p)}">
        <span class="watchlist-platform">${H(platformLabel(p))}</span>
        <span class="watchlist-status">${watchedSet.has(p) ? '● Watching' : '○ Off'}</span>
      </div>
    `).join('');

    watchlistGrid.addEventListener('click', async (e) => {
      const item = e.target.closest('[data-platform]');
      if (!item) return;
      const platform = item.dataset.platform;
      const isActive = item.classList.contains('watchlist-item--active');
      item.style.opacity = '0.5';
      try {
        const { upsertWatch, removeWatch } = await import('./api.js');
        if (isActive) {
          await removeWatch(platform);
          item.classList.remove('watchlist-item--active');
          item.querySelector('.watchlist-status').textContent = '○ Off';
        } else {
          await upsertWatch(platform, { notifyEmail: true });
          item.classList.add('watchlist-item--active');
          item.querySelector('.watchlist-status').textContent = '● Watching';
        }
      } catch (err) { showToast(err.message, 'error'); }
      finally { item.style.opacity = '1'; }
    });
  }

  // ── Load webhook settings ─────────────────────────────────────────────────
  try {
    const { fetchWebhookSettings } = await import('./api.js');
    const settings = await fetchWebhookSettings();
    if (settings?.data) {
      const d = settings.data;
      if (d.slack_url)   document.getElementById('wh-slack').value   = d.slack_url;
      if (d.webhook_url) document.getElementById('wh-custom').value  = d.webhook_url;
      if (d.enabled != null) document.getElementById('wh-enabled').checked = d.enabled;
    }
  } catch { /* unavailable */ }

  document.getElementById('wh-save')?.addEventListener('click', async () => {
    const btn  = document.getElementById('wh-save');
    const errEl = document.getElementById('webhook-error');
    const okEl  = document.getElementById('webhook-success');
    errEl.classList.add('hidden'); okEl.classList.add('hidden');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { upsertWebhookSettings } = await import('./api.js');
      await upsertWebhookSettings({
        slackUrl:   document.getElementById('wh-slack').value  || undefined,
        webhookUrl: document.getElementById('wh-custom').value || undefined,
        enabled:    document.getElementById('wh-enabled').checked,
      });
      okEl.classList.remove('hidden');
    } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    finally { btn.disabled = false; btn.textContent = 'Save webhook settings'; }
  });
}


// ── ADMIN DASHBOARD ───────────────────────────────────────────────────────────
async function renderAdmin() {
  if (!isLoggedIn()) { navigate('/login'); return; }
  const user = getUser();
  if (user.role !== 'admin') { navigate('/'); return; }

  setHTML(`
    ${renderNav(user)}
    <div class="admin-page">
      <div class="admin-header">
        <h1 class="admin-title">Admin Dashboard</h1>
        <span class="admin-subtitle">PatchTicker Operations</span>
      </div>

      <!-- Stats strip -->
      <div class="admin-stats" id="admin-stats">
        ${[...Array(6)].map(() => `<div class="admin-stat-card">${spinner()}</div>`).join('')}
      </div>

      <!-- Tabs -->
      <div class="admin-tabs">
        <button class="admin-tab admin-tab--active" data-tab="users">Users</button>
        <button class="admin-tab" data-tab="subscriptions">Subscriptions</button>
        <button class="admin-tab" data-tab="ai-log">Review Log</button>
        <button class="admin-tab" data-tab="pipeline">Pipeline</button>
      </div>

      <!-- Tab panels -->
      <div id="admin-panel-users" class="admin-panel">
        <div class="admin-table-wrap" id="users-table-wrap">${spinner()}</div>
      </div>
      <div id="admin-panel-subscriptions" class="admin-panel hidden">
        <div class="admin-table-wrap" id="subs-table-wrap">${spinner()}</div>
      </div>
      <div id="admin-panel-ai-log" class="admin-panel hidden">
        <div class="admin-table-wrap" id="ailog-table-wrap">${spinner()}</div>
      </div>
      <div id="admin-panel-pipeline" class="admin-panel hidden">
        <div class="pipeline-controls">
          <div class="pipeline-actions">
            <button class="btn btn--primary btn--sm" id="pipeline-run-all">▶ Run full scan now</button>
            <select class="field-input pipeline-platform-select" id="pipeline-platform-select">
              <option value="">— or run single platform —</option>
              <option>AMD</option><option>NVIDIA</option><option>Intel</option>
              <option>Apple</option><option>macOS</option><option>Windows</option>
              <option>Steam</option><option>Epic</option><option>Xbox</option><option>PS5</option>
            </select>
            <button class="btn btn--outline btn--sm" id="pipeline-run-one">Run selected</button>
          </div>
          <p class="pipeline-note">Scans run automatically every 6 hours. Security platforms (Windows, Apple, macOS) scan every hour.</p>
        </div>
        <div id="pipeline-status-wrap" class="admin-table-wrap">${spinner()}</div>
      </div>
    </div>
  `);
  attachNavHandlers(user);

  // ── Tab switching ─────────────────────────────────────────────────────────
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('admin-tab--active'));
      document.querySelectorAll('.admin-panel').forEach(p => p.classList.add('hidden'));
      tab.classList.add('admin-tab--active');
      document.getElementById(`admin-panel-${tab.dataset.tab}`)?.classList.remove('hidden');
    });
  });

  // ── Load stats ────────────────────────────────────────────────────────────
  try {
    const { fetchAdminStats } = await import('./api.js');
    const { users, subscriptions } = (await fetchAdminStats()).data ?? { users: {}, subscriptions: {} };
    document.getElementById('admin-stats').innerHTML = `
      <div class="admin-stat-card"><div class="admin-stat-value">${users.total_users ?? '—'}</div><div class="admin-stat-label">Total users</div></div>
      <div class="admin-stat-card"><div class="admin-stat-value">${users.pro_users ?? '—'}</div><div class="admin-stat-label">Pro</div></div>
      <div class="admin-stat-card"><div class="admin-stat-value">${users.free_users ?? '—'}</div><div class="admin-stat-label">Free</div></div>
      <div class="admin-stat-card"><div class="admin-stat-value">${users.new_today ?? '—'}</div><div class="admin-stat-label">New today</div></div>
      <div class="admin-stat-card"><div class="admin-stat-value">${subscriptions.active ?? '—'}</div><div class="admin-stat-label">Active subs</div></div>
      <div class="admin-stat-card"><div class="admin-stat-value">${subscriptions.trialing ?? '—'}</div><div class="admin-stat-label">Trialing</div></div>
    `;
  } catch { document.getElementById('admin-stats').innerHTML = '<p class="admin-error">Stats unavailable.</p>'; }

  // ── Load users table ──────────────────────────────────────────────────────
  async function loadUsers() {
    try {
      const { fetchAdminUsers, patchUserRole } = await import('./api.js');
      const res   = await fetchAdminUsers(1);
      const users = res.users || [];

      const rows = users.map(u => `
        <tr>
          <td class="admin-td admin-td--email">${H(u.email || '—')}</td>
          <td class="admin-td">
            <select class="admin-role-select" data-user-id="${H(u.id)}" data-current-role="${H(u.role)}">
              <option value="free"  ${u.role === 'free'  ? 'selected' : ''}>free</option>
              <option value="pro"   ${u.role === 'pro'   ? 'selected' : ''}>pro</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
            </select>
          </td>
          <td class="admin-td">${u.emailVerified ? '✓' : '✗'}</td>
          <td class="admin-td admin-td--sub">${u.subscription?.status ?? '—'}</td>
          <td class="admin-td admin-td--date">${new Date(u.createdAt).toLocaleDateString()}</td>
        </tr>
      `).join('');

      document.getElementById('users-table-wrap').innerHTML = `
        <table class="admin-table">
          <thead><tr>
            <th class="admin-th">Email</th>
            <th class="admin-th">Role</th>
            <th class="admin-th">Verified</th>
            <th class="admin-th">Subscription</th>
            <th class="admin-th">Joined</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="admin-td">No users found.</td></tr>'}</tbody>
        </table>
        <p class="admin-count">${res.pagination?.total ?? 0} total users</p>
      `;

      // Role change handlers
      document.querySelectorAll('.admin-role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          const userId = sel.dataset.userId;
          const role   = sel.value;
          sel.disabled = true;
          try {
            await patchUserRole(userId, role);
            showToast(`Role updated to ${role}`, 'success');
          } catch (err) {
            showToast(err.message, 'error');
            sel.value = sel.dataset.currentRole;
          } finally { sel.disabled = false; }
        });
      });
    } catch (err) { document.getElementById('users-table-wrap').innerHTML = `<p class="admin-error">${H(err.message)}</p>`; }
  }

  // ── Load subscriptions table ──────────────────────────────────────────────
  async function loadSubscriptions() {
    try {
      const { fetchAdminSubscriptions } = await import('./api.js');
      const res  = await fetchAdminSubscriptions(1);
      const subs = res.subscriptions || [];

      const rows = subs.map(s => `
        <tr>
          <td class="admin-td admin-td--email">${H(s.email || '—')}</td>
          <td class="admin-td"><span class="status-badge ${H(s.status)}">${H(s.status)}</span></td>
          <td class="admin-td">${s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : '—'}</td>
          <td class="admin-td">${s.cancel_at_period_end ? '⚠ Cancels' : '—'}</td>
          <td class="admin-td admin-td--date">${new Date(s.created_at).toLocaleDateString()}</td>
        </tr>
      `).join('');

      document.getElementById('subs-table-wrap').innerHTML = `
        <table class="admin-table">
          <thead><tr>
            <th class="admin-th">Email</th>
            <th class="admin-th">Status</th>
            <th class="admin-th">Renews</th>
            <th class="admin-th">Flag</th>
            <th class="admin-th">Created</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="admin-td">No subscriptions found.</td></tr>'}</tbody>
        </table>
        <p class="admin-count">${res.pagination?.total ?? 0} total subscriptions</p>
      `;
    } catch (err) { document.getElementById('subs-table-wrap').innerHTML = `<p class="admin-error">${H(err.message)}</p>`; }
  }

  // ── Load review log table ──────────────────────────────────────────────────
  async function loadAiLog() {
    try {
      const { fetchAiLog } = await import('./api.js');
      const entries = (await fetchAiLog(100)).data || [];

      const rows = entries.map(e => `
        <tr>
          <td class="admin-td">${H(e.update_id)}</td>
          <td class="admin-td">${H(e.model)}</td>
          <td class="admin-td">${e.tokens_in ?? '—'}</td>
          <td class="admin-td">${e.tokens_out ?? '—'}</td>
          <td class="admin-td">${e.latency_ms ? `${e.latency_ms}ms` : '—'}</td>
          <td class="admin-td">${e.success ? '<span style="color:var(--green)">✓</span>' : `<span style="color:var(--red)" title="${H(e.error_msg || '')}">✗</span>`}</td>
          <td class="admin-td admin-td--date">${new Date(e.created_at).toLocaleString()}</td>
        </tr>
      `).join('');

      document.getElementById('ailog-table-wrap').innerHTML = `
        <table class="admin-table">
          <thead><tr>
            <th class="admin-th">Update ID</th>
            <th class="admin-th">Model</th>
            <th class="admin-th">Tokens In</th>
            <th class="admin-th">Tokens Out</th>
            <th class="admin-th">Latency</th>
            <th class="admin-th">OK</th>
            <th class="admin-th">Timestamp</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="admin-td">No review log entries.</td></tr>'}</tbody>
        </table>
        <p class="admin-count">${entries.length} entries shown</p>
      `;
    } catch (err) { document.getElementById('ailog-table-wrap').innerHTML = `<p class="admin-error">${H(err.message)}</p>`; }
  }

  loadUsers();
  loadSubscriptions();
  loadAiLog();

  // ── Pipeline tab ──────────────────────────────────────────────────────────
  async function loadPipelineStatus() {
    try {
      const { fetchPipelineStatus } = await import('./api.js');
      const res  = await fetchPipelineStatus();
      const rows = res.data || [];
      const wrap = document.getElementById('pipeline-status-wrap');
      if (!wrap) return;

      if (!rows.length) {
        wrap.innerHTML = '<p class="admin-error">No pipeline data yet — run a scan to populate.</p>';
        return;
      }

      wrap.innerHTML = `
        <table class="admin-table">
          <thead><tr>
            <th class="admin-th">Platform</th>
            <th class="admin-th">Latest Version</th>
            <th class="admin-th">Last Release</th>
            <th class="admin-th">Last Detected</th>
            <th class="admin-th">Total Versions</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="admin-td"><a href="#/platform/${H(r.platform)}" style="color:var(--text)">${H(r.platform)}</a></td>
              <td class="admin-td" style="font-family:var(--font-mono);font-size:11px">${H(r.latest_version || '—')}</td>
              <td class="admin-td admin-td--date">${r.last_release ? new Date(r.last_release).toLocaleDateString() : '—'}</td>
              <td class="admin-td admin-td--date">${r.last_detected ? new Date(r.last_detected).toLocaleString() : '—'}</td>
              <td class="admin-td">${r.total_versions}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      const wrap = document.getElementById('pipeline-status-wrap');
      if (wrap) wrap.innerHTML = `<p class="admin-error">${H(err.message)}</p>`;
    }
  }

  loadPipelineStatus();

  document.getElementById('pipeline-run-all')?.addEventListener('click', async () => {
    const btn = document.getElementById('pipeline-run-all');
    btn.disabled = true; btn.textContent = '⏳ Running…';
    try {
      const { triggerPipeline } = await import('./api.js');
      const res = await triggerPipeline(null);
      const failures = res.errors || [];
      showToast(failures.length ? `Pipeline completed with ${failures.length} errors.` : 'Full pipeline completed.', failures.length ? 'error' : 'success');
      if (failures.length) console.warn('PatchTicker pipeline failures', failures);
      await loadPipelineStatus();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = '▶ Run full scan now'; }
  });

  document.getElementById('pipeline-run-one')?.addEventListener('click', async () => {
    const platform = document.getElementById('pipeline-platform-select')?.value;
    if (!platform) { showToast('Select a platform first.', 'info'); return; }
    const btn = document.getElementById('pipeline-run-one');
    btn.disabled = true; btn.textContent = '⏳ Running…';
    try {
      const { triggerPipeline } = await import('./api.js');
      const res = await triggerPipeline(platform);
      const failures = res.errors || [];
      showToast(failures.length ? `${platform} pipeline failed.` : `${platform} pipeline completed.`, failures.length ? 'error' : 'success');
      if (failures.length) console.warn('PatchTicker pipeline failures', failures);
      await loadPipelineStatus();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Run selected'; }
  });
}


// ── PUBLIC PLATFORM PAGE ──────────────────────────────────────────────────────
async function renderPlatformPage(platformName) {
  const user = getUser();
  const name = decodeURIComponent(platformName);

  const PLATFORM_COLOR = {
    AMD: '#ef4444', NVIDIA: '#22c55e', Intel: '#0071c5', Apple: '#9ca3af',
    macOS: '#a78bfa', Windows: '#60a5fa', Steam: '#64748b', Epic: '#0a84ff',
    Xbox: '#107c10', PS5: '#3b82f6',
  };
  const color = PLATFORM_COLOR[name] || '#888';

  setHTML(`
    ${renderNav(user)}
    <div class="platform-page">
      <div class="platform-hero" style="border-left:4px solid ${color}">
        <div class="platform-hero-inner">
          <a class="platform-back" href="#/updates">← All platforms</a>
          <h1 class="platform-title">${H(name)}</h1>
          <p class="platform-subtitle">Update history &amp; community reports</p>
        </div>
      </div>

      <div class="platform-body">
        <!-- Current update summary -->
        <div class="platform-current" id="platform-current">${spinner()}</div>

        <!-- Score history -->
        <section class="platform-section">
          <h2 class="platform-section-title">Version History</h2>
          <div id="platform-history">${spinner()}</div>
        </section>

        <!-- Community bug reports -->
        <section class="platform-section">
          <h2 class="platform-section-title">Community Bug Reports</h2>
          <div id="platform-bugs">${spinner()}</div>
        </section>
      </div>
    </div>
  `);
  attachNavHandlers(user);

  // ── Load current update ───────────────────────────────────────────────────
  const { fetchUpdates } = await import('./api.js');
  try {
    const res  = await fetchUpdates({ platform: name });
    const updates = res.data || [];
    const current = updates[0];
    const currentEl = document.getElementById('platform-current');

    if (!current) {
      currentEl.innerHTML = '<p class="platform-empty">No update data yet for this platform.</p>';
    } else {
      const color  = scoreColor(current.score);
      const status = current.status || 'caution';
      const statusColors = { stable: 'var(--green)', caution: 'var(--yellow)', avoid: 'var(--red)' };
      currentEl.innerHTML = `
        <div class="platform-current-card" style="border-color:${color}">
          <div class="platform-current-left">
            <div class="platform-current-version">${H(current.name)}</div>
            <div class="platform-current-meta">
              v${H(current.version)} · Released ${new Date(current.releasedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
            </div>
            <div class="platform-current-verdict">${H(current.verdict || 'Review pending.')}</div>
          </div>
          <div class="platform-current-right">
            <div class="platform-score-ring" style="--ring-color:${color}">
              <span class="platform-score-num" style="color:${color}">${current.score?.toFixed(1)}</span>
              <span class="platform-score-label">/ 10</span>
            </div>
            <div class="platform-status-badge" style="color:${statusColors[status]||'#888'};border-color:${statusColors[status]||'#888'}">
              ${status.toUpperCase()}
            </div>
            <a class="btn btn--outline btn--sm" href="#/update/${H(current.id)}">Full details →</a>
          </div>
        </div>
      `;
    }
  } catch (err) {
    document.getElementById('platform-current').innerHTML =
      `<p class="platform-empty">Could not load current update.</p>`;
  }

  // ── Load version history ──────────────────────────────────────────────────
  const { fetchPlatformHistory } = await import('./api.js');
  try {
    const histRes  = await fetchPlatformHistory(name, 20);
    const history  = histRes.data || [];
    const histEl   = document.getElementById('platform-history');

    if (!history.length) {
      histEl.innerHTML = '<p class="platform-empty">No version history yet — pipeline will populate this automatically.</p>';
    } else {
      histEl.innerHTML = `
        <div class="history-table-wrap">
          <table class="history-table">
            <thead><tr>
              <th class="history-th">Version</th>
              <th class="history-th">Released</th>
              <th class="history-th">Score</th>
              <th class="history-th">Status</th>
              <th class="history-th">Bugs</th>
              <th class="history-th"></th>
            </tr></thead>
            <tbody>
              ${history.map(h => {
                const c = scoreColor(h.score);
                const statusColors = { stable: 'var(--green)', caution: 'var(--yellow)', avoid: 'var(--red)' };
                return `<tr class="history-row">
                  <td class="history-td history-td--version">${H(h.version)}</td>
                  <td class="history-td history-td--date">${new Date(h.releasedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</td>
                  <td class="history-td"><span style="color:${c};font-weight:700">${h.score?.toFixed(1)}</span></td>
                  <td class="history-td"><span class="history-status" style="color:${statusColors[h.status]||'#888'}">${(h.status||'').toUpperCase()}</span></td>
                  <td class="history-td">${h.bugCount ?? '—'}</td>
                  <td class="history-td"><a class="history-link" href="#/update/${H(h.id)}">View →</a></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  } catch (err) {
    document.getElementById('platform-history').innerHTML =
      '<p class="platform-empty">Version history unavailable.</p>';
  }

  // ── Load community bug reports for this platform ──────────────────────────
  // Pull the most recent update's ID to fetch its bug reports
  const { fetchUpdates: fu2, fetchBugReports } = await import('./api.js');
  try {
    const res2    = await fu2({ platform: name });
    const current2 = (res2.data || [])[0];
    const bugsEl  = document.getElementById('platform-bugs');

    if (!current2) {
      bugsEl.innerHTML = '<p class="platform-empty">No update loaded yet.</p>';
    } else {
      const bugRes  = await fetchBugReports(current2.id);
      const reports = bugRes.data || [];
      renderBugFeed(bugsEl, reports, current2.id);
    }
  } catch (err) {
    document.getElementById('platform-bugs').innerHTML =
      '<p class="platform-empty">Bug reports unavailable.</p>';
  }
}


// ── SHARED FOOTER ─────────────────────────────────────────────────────────────
function renderFooter() {
  return `
    <footer class="site-footer">
      <div class="site-footer-inner">
        <span class="site-footer-brand"><span class="brand-pulse">Patch</span>Ticker</span>
        <nav class="site-footer-nav">
          <a href="#/" class="site-footer-link">Home</a>
          <a href="#/updates" class="site-footer-link">Updates</a>
          <a href="#/pricing" class="site-footer-link">Pricing</a>
          <a href="#/privacy" class="site-footer-link">Privacy Policy</a>
          <a href="#/terms" class="site-footer-link">Terms of Service</a>
        </nav>
        <span class="site-footer-copy">© ${new Date().getFullYear()} Dorn Ventures LLC. All rights reserved.</span>
      </div>
    </footer>
  `;
}


// ── PRIVACY POLICY ────────────────────────────────────────────────────────────
function renderPrivacy() {
  const user = getUser();
  const EFFECTIVE = 'July 17, 2026';

  setHTML(`
    ${renderNav(user)}
    <div class="legal-page">
      <div class="legal-header">
        <h1 class="legal-title">Privacy Policy</h1>
        <p class="legal-effective">Effective date: ${EFFECTIVE}</p>
      </div>
      <div class="legal-body">

        <p>PatchTicker ("we", "us", or "our") is operated by Dorn Ventures LLC. This Privacy Policy explains what information we collect, how we use it, and your rights regarding your data when you use patchticker.app (the "Service").</p>

        <h2>1. Information We Collect</h2>
        <p><strong>Account information.</strong> When you register, we collect your email address and a hashed version of your password. Your email is encrypted at rest using AES-256-GCM. We never store your password in plain text.</p>
        <p><strong>Usage data.</strong> We collect standard server logs including IP addresses, browser user-agent strings, pages visited, and timestamps. Logs are retained for 30 days and then deleted automatically.</p>
        <p><strong>Payment information.</strong> Payments are processed by Stripe. We never see or store your full card number. We receive a Stripe customer ID and subscription status only.</p>
        <p><strong>Submitted content.</strong> Bug reports and community feed posts you submit are stored encrypted at rest and associated with your account.</p>
        <p><strong>Cookies.</strong> We use a single HTTP-only authentication cookie to keep you signed in. No third-party tracking cookies are set. Google AdSense (shown to free-tier users only) may set its own cookies governed by Google's privacy policy.</p>

        <h2>2. How We Use Your Information</h2>
        <ul>
          <li>To operate and provide the Service</li>
          <li>To process payments and manage your subscription</li>
          <li>To send transactional emails (verification, password reset, patch alerts you subscribed to)</li>
          <li>To detect and prevent fraud, abuse, and security incidents</li>
          <li>To improve the Service through aggregated, anonymised analytics</li>
        </ul>
        <p>We do not sell your personal data to third parties. We do not use your data for advertising targeting beyond what AdSense does autonomously for free-tier ad display.</p>

        <h2>3. Data Sharing</h2>
        <p>We share data only with the following service providers, strictly for operating the Service:</p>
        <ul>
          <li><strong>Stripe</strong> — payment processing</li>
          <li><strong>Supabase</strong> — database hosting</li>
          <li><strong>SendGrid</strong> — transactional email delivery</li>
          <li><strong>Google AdSense</strong> — advertising (free-tier users only)</li>
          <li><strong>hCaptcha</strong> — bot protection at registration</li>
        </ul>

        <h2>4. Data Retention</h2>
        <p>We retain your account data for as long as your account is active. If you delete your account, your email, posts, and bug reports are deleted within 7 days. Server logs are purged after 30 days. Stripe retains payment records per their own retention policy.</p>

        <h2>5. Your Rights</h2>
        <p>Depending on your jurisdiction, you may have rights to access, correct, export, or delete your personal data. To exercise these rights, email us at <strong>privacy@patchticker.app</strong>. We will respond within 30 days.</p>
        <p>If you are in the European Economic Area, you have the right to lodge a complaint with your local data protection authority.</p>

        <h2>6. Security</h2>
        <p>We use industry-standard security practices: TLS in transit, AES-256-GCM encryption at rest for PII, argon2id password hashing, short-lived JWT access tokens, and rate limiting on all sensitive endpoints. No system is perfectly secure, and we cannot guarantee absolute security.</p>

        <h2>7. Children</h2>
        <p>The Service is not directed at children under 13. We do not knowingly collect personal data from children. If you believe a child has provided us with personal data, contact us and we will delete it promptly.</p>

        <h2>8. Changes to This Policy</h2>
        <p>We may update this policy from time to time. Material changes will be notified by email to registered users at least 14 days before taking effect. The effective date at the top of this page will always reflect the current version.</p>

        <h2>9. Contact</h2>
        <p>Questions or requests regarding this policy can be sent to <strong>privacy@patchticker.app</strong> or by mail to: Dorn Ventures LLC, United States.</p>

      </div>
    </div>
    ${renderFooter()}
  `);
  attachNavHandlers(user);
}


// ── TERMS OF SERVICE ──────────────────────────────────────────────────────────
function renderTerms() {
  const user = getUser();
  const EFFECTIVE = 'July 17, 2026';

  setHTML(`
    ${renderNav(user)}
    <div class="legal-page">
      <div class="legal-header">
        <h1 class="legal-title">Terms of Service</h1>
        <p class="legal-effective">Effective date: ${EFFECTIVE}</p>
      </div>
      <div class="legal-body">

        <p>These Terms of Service ("Terms") govern your access to and use of PatchTicker, operated by Dorn Ventures LLC ("Company", "we", "us"). By creating an account or using the Service, you agree to these Terms.</p>

        <h2>1. The Service</h2>
        <p>PatchTicker aggregates publicly available software update information, community reports, source links, and team-reviewed guidance to help users make informed decisions about installing software updates. <strong>All safety scores, verdicts, and recommendations are informational only and do not constitute professional advice.</strong> You are solely responsible for decisions made based on content provided by the Service.</p>

        <h2>2. Accounts</h2>
        <p>You must be at least 13 years old to create an account. You are responsible for maintaining the confidentiality of your account credentials and for all activity under your account. You must provide accurate information at registration and keep it current.</p>

        <h2>3. Subscriptions and Billing</h2>
        <p>Pro subscriptions are billed monthly or annually as selected at checkout. Subscriptions renew automatically unless cancelled before the renewal date. You may cancel at any time through your account settings; cancellation takes effect at the end of the current billing period with no prorated refund unless required by applicable law. Prices may change with 30 days' notice.</p>
        <p>Payments are processed by Stripe. By subscribing, you authorise Stripe to charge your payment method on our behalf.</p>

        <h2>4. Free Tier and Advertising</h2>
        <p>Free-tier users receive access to the full update feed supported by Google AdSense advertising. By using the free tier, you acknowledge that advertisements will be displayed. Pro subscribers receive an ad-free experience.</p>

        <h2>5. User-Submitted Content</h2>
        <p>You may submit bug reports and community feed posts ("Content"). By submitting Content, you grant us a non-exclusive, worldwide, royalty-free licence to store, display, and moderate that Content in connection with the Service. You represent that your Content is accurate to the best of your knowledge, does not violate any law, and does not infringe any third-party rights.</p>
        <p>We may remove Content at our discretion, including Content that is false, abusive, spam, or otherwise violates these Terms.</p>

        <h2>6. Prohibited Uses</h2>
        <p>You may not use the Service to: submit false or misleading bug reports; attempt to manipulate safety scores; scrape or harvest data through automated means beyond our public API; circumvent rate limits or security measures; or use the Service in any way that violates applicable law.</p>

        <h2>7. API Access</h2>
        <p>Pro subscribers may access the PatchTicker REST API subject to rate limits described in our documentation. API access is provided as-is and may be modified or discontinued. You may not resell or redistribute raw API data as a competing service.</p>

        <h2>8. Disclaimers</h2>
        <p>THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND. WE DO NOT WARRANT THAT SCORES OR VERDICTS ARE ACCURATE, COMPLETE, OR UP TO DATE. USE OF ANY SOFTWARE UPDATE IS AT YOUR OWN RISK. TO THE FULLEST EXTENT PERMITTED BY LAW, WE DISCLAIM ALL LIABILITY FOR DAMAGES ARISING FROM YOUR USE OF THE SERVICE OR RELIANCE ON ITS CONTENT.</p>

        <h2>9. Limitation of Liability</h2>
        <p>To the maximum extent permitted by applicable law, Dorn Ventures LLC's total liability to you for any claim arising from these Terms or your use of the Service shall not exceed the greater of (a) the amount you paid us in the 12 months before the claim arose, or (b) $50 USD.</p>

        <h2>10. Termination</h2>
        <p>We may suspend or terminate your account at any time for violation of these Terms, with or without notice. You may delete your account at any time through account settings. Upon termination, your right to use the Service ceases immediately.</p>

        <h2>11. Governing Law</h2>
        <p>These Terms are governed by the laws of the United States. Any disputes shall be resolved through binding arbitration under the American Arbitration Association rules, except that either party may seek injunctive relief in a court of competent jurisdiction.</p>

        <h2>12. Changes to Terms</h2>
        <p>We may modify these Terms at any time. Material changes will be notified by email at least 14 days in advance. Continued use of the Service after the effective date constitutes acceptance of the updated Terms.</p>

        <h2>13. Contact</h2>
        <p>Questions about these Terms can be sent to <strong>legal@patchticker.app</strong> or by mail to: Dorn Ventures LLC, United States.</p>

      </div>
    </div>
    ${renderFooter()}
  `);
  attachNavHandlers(user);
}


async function boot() {
  renderLoading();

  // Try to restore session from refresh token cookie
  await restoreSession();
  // Expose access token for SSE (EventSource cannot set custom headers)
  window.__feedToken__ = (await import('./api.js')).getAccessToken();

  // Auth event listeners
  onAuthChange((event) => {
    if (event === 'expired') {
      showToast('Session expired. Please sign in again.', 'error');
      navigate('/login');
    }
  });

  // Register routes
  route('/', () => renderLanding());
  route('/updates', () => renderDashboard());
  route('/update/:id', ({ id }) => renderUpdateDetail(id));
  route('/login', () => isLoggedIn() ? navigate('/updates') : renderLogin());
  route('/register', () => isLoggedIn() ? navigate('/updates') : renderRegister());
  route('/pricing', () => renderPricing());
  route('/forgot-password', () => renderForgotPassword());
  route('/reset-password', (params) => renderResetPassword(params));
  route('/verify-email', (params) => renderVerifyEmail(params));

  route('/account',          () => renderAccount());
  route('/admin',            () => renderAdmin());
  route('/platform/:name',   ({ name }) => renderPlatformPage(name));
  route('/privacy',          () => renderPrivacy());
  route('/terms',            () => renderTerms());

  // Handle Stripe redirect params
  const hash = window.location.hash;
  if (hash.includes('checkout=success')) {
    showToast('Subscription activated! Welcome to Pro.', 'success');
    // User just upgraded — remove ads immediately without requiring a page reload.
    // The AdSense script and all <ins> units are removed from the DOM right now.
    unloadAds();
    // Remove the query param from hash
    window.history.replaceState(null, '', window.location.pathname + '#/');
  } else if (hash.includes('checkout=canceled')) {
    showToast('Checkout canceled.', 'info');
    window.history.replaceState(null, '', window.location.pathname + '#/pricing');
  }

  start();
}

boot();
