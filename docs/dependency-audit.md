# Dependency audit status

The npm workspaces share the **root** `package-lock.json`. Run `npm run audit`
from the repository root (or `npm run audit:check` in either workspace). The
collector writes `audit-reports/{all,production,summary}.json`, returns 1 for
moderate-or-higher findings, and returns 2 when a scan fails or its JSON cannot
be trusted. CI and the weekly workflow preserve that failure after uploading
the reports. OSV scanner failures also fail CI.

## October 6, 2026 review

- The critical `shell-quote` path through development-only `concurrently` was
  upgraded to `shell-quote@1.12.0` via a root override. The advisory states the
  fix landed in 1.11.0: https://github.com/advisories/GHSA-pqg4-j6r4-53mv
- Jest was upgraded to 30.5.2, `source-map-js` to 1.2.2, and `nodemon` was
  replaced with Node's built-in `--watch`. This removed the high-severity
  `braces` path.
- Full-lockfile audit: **19 moderate, 0 high, 0 critical**. These are metadata
  findings through Jest's coverage tooling: `@istanbuljs/load-nyc-config` uses
  `js-yaml@3`, which uses `argparse@1` and `sprintf-js@1`. The current
  `sprintf-js` advisory lists **no patched version**:
  https://github.com/advisories/GHSA-hp3w-g68c-fv3c . No override to an
  incompatible YAML major version was shipped without upstream support.
- Production-only audit: **0 findings**. Render's build now prunes development
  packages after building the frontend. This reduces runtime package exposure;
  it does not prove that every possible deployment or build-time use is safe.

The full audit remains **red by design** while the unpatched development-tool
chain is present. Do not mark it clean, suppress its exit code, or infer from a
clean production-only audit that a vulnerability was never present in a build
environment. Recheck the upstream advisories and upgrade when a supported fix
becomes available.
