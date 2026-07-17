// vite.config.js
// ─────────────────────────────────────────────────────────────────────────────
// VITE CONFIGURATION — dev server, proxy, env vars, and CSP
//
// ENVIRONMENT VARIABLES
// ──────────────────────
//  Vite exposes only VITE_* prefixed vars to the frontend bundle.
//  Server-side secrets (STRIPE_SECRET_KEY, JWT secrets, etc.) are NEVER
//  available here — they are only in the backend .env.
//
//  Add to frontend .env:
//    VITE_STRIPE_PRICE_MONTHLY=price_xxx
//    VITE_STRIPE_PRICE_ANNUAL=price_xxx
//
// CSP
// ────
//  Stripe Checkout runs on stripe.com (redirect), so no CSP change is needed
//  for the redirect flow. If using Stripe.js embedded elements in future,
//  add https://js.stripe.com to script-src and connect-src.
// ─────────────────────────────────────────────────────────────────────────────

import { defineConfig, loadEnv } from 'vite';

const FRONTEND_CSP = [
  "default-src 'none'",
  // hCaptcha + Google AdSense scripts
  // TODO: ca-pub-XXXXXXXXXXXXXXXX — replace with real publisher ID when live
  "script-src 'self' https://hcaptcha.com https://*.hcaptcha.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net",
  "style-src 'self' https://fonts.googleapis.com https://hcaptcha.com https://*.hcaptcha.com",
  "font-src 'self' https://fonts.gstatic.com",
  // hCaptcha + AdSense network calls
  "connect-src 'self' https://hcaptcha.com https://*.hcaptcha.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net",
  // AdSense ad images served from Google CDNs
  "img-src 'self' data: https://hcaptcha.com https://*.hcaptcha.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net",
  // hCaptcha + AdSense both render iframes
  "frame-src https://hcaptcha.com https://*.hcaptcha.com https://googleads.g.doubleclick.net https://tpc.googlesyndication.com",
  "frame-ancestors 'none'",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join('; ');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    root:      '.',
    publicDir: 'public',

    // Make VITE_* env vars available as import.meta.env.* in the bundle
    define: {
      // Expose price IDs to index.html template substitution
      '__STRIPE_PRICE_MONTHLY__':  JSON.stringify(env.VITE_STRIPE_PRICE_MONTHLY  || ''),
      '__STRIPE_PRICE_ANNUAL__':   JSON.stringify(env.VITE_STRIPE_PRICE_ANNUAL   || ''),
      // hCaptcha public site key — safe to expose in bundle
      '__HCAPTCHA_SITE_KEY__':     JSON.stringify(env.VITE_HCAPTCHA_SITE_KEY     || ''),
    },

    server: {
      port: 3000,
      proxy: {
        '/api': {
          target:       'http://localhost:4000',
          changeOrigin: true,
        },
      },
      headers: {
        'Content-Security-Policy': FRONTEND_CSP,
        'X-Frame-Options':         'DENY',
        'X-Content-Type-Options':  'nosniff',
        'Referrer-Policy':         'strict-origin-when-cross-origin',
        'Permissions-Policy': [
          'camera=()', 'microphone=()', 'geolocation=()',
          'payment=()', 'usb=()', 'fullscreen=(self)',
        ].join(', '),
      },
    },

    build: {
      outDir:      'dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
