/**
 * Canonical PatchTicker release object.
 *
 * Version strings are intentionally opaque. Many tracked ecosystems do not use
 * SemVer, so consumers must use `scheme` and must not compare `raw` lexically.
 */

export type ReleaseType =
  | 'security'
  | 'feature'
  | 'hotfix'
  | 'driver'
  | 'firmware'
  | 'quality'
  | 'maintenance'
  | 'beta'
  | 'other';

export type Severity = 'none' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';
export type ReleaseChannel =
  | 'stable'
  | 'extended-stable'
  | 'preview'
  | 'beta'
  | 'dev'
  | 'canary'
  | 'insider'
  | 'hotfix'
  | 'other';

export interface UpdateVersion {
  /** Exact vendor representation, for example `24H2 (26100.4652)`. */
  raw: string;
  scheme: 'semver' | 'calver' | 'build' | 'kb' | 'firmware' | 'opaque';
  normalized?: string;
  build?: string;
  previous?: string;
}

export interface PlatformTarget {
  os?: string;
  osVersion?: string;
  architecture?: 'x86' | 'x64' | 'arm' | 'arm64' | 'universal' | 'other';
  deviceFamily?: string;
  hardwareIds?: string[];
  locale?: string;
}

export interface ChangelogItem {
  id?: string;
  kind: 'highlight' | 'fixed' | 'known-issue' | 'security' | 'breaking-change' | 'deprecated' | 'other';
  title: string;
  description?: string;
  affected?: string[];
  cveIds?: string[];
  issueUrls?: string[];
}

export interface SourceEvidence {
  provider: string;
  externalId?: string;
  url: string;
  kind: 'official-api' | 'official-rss' | 'official-html' | 'official-pdf' | 'webhook' | 'secondary';
  publishedAt?: string;
  fetchedAt: string;
  contentSha256?: string;
  language?: string;
}

export interface DownloadArtifact {
  url: string;
  label?: string;
  operatingSystem?: string;
  architecture?: PlatformTarget['architecture'];
  sizeBytes?: number;
  sha256?: string;
  official: boolean;
}

export interface UpdateFeedItem {
  /** UUID or stable application-generated identifier. */
  id: string;
  /** SHA-256 of provider/product/channel/version/targets for idempotency. */
  canonicalKey: string;
  provider: {
    id: string;
    name: string;
  };
  product: {
    id: string;
    name: string;
    family?: string;
  };
  title: string;
  version: UpdateVersion;
  channel: ReleaseChannel;
  releaseTypes: ReleaseType[];
  severity: Severity;
  /** True only with authoritative evidence of active exploitation. */
  exploitedInTheWild?: boolean;
  mandatory?: boolean;
  rollout: {
    status: 'announced' | 'rolling-out' | 'available' | 'paused' | 'withdrawn' | 'superseded';
    phased: boolean;
    percentage?: number;
    regions?: string[];
  };
  targets: PlatformTarget[];
  tags: string[];
  summary: string;
  highlights: string[];
  changelog: ChangelogItem[];
  cveIds: string[];
  sources: SourceEvidence[];
  downloads: DownloadArtifact[];
  timestamps: {
    announcedAt?: string;
    releasedAt: string;
    rolloutStartedAt?: string;
    sourceFirstSeenAt: string;
    indexedAt: string;
    updatedAt: string;
  };
  parser: {
    name: string;
    version: string;
    method: 'deterministic' | 'llm-assisted' | 'human';
    confidence: number;
    reviewed: boolean;
  };
  telemetry?: {
    indexingLatencySeconds: number;
    intentHalfLifeSeconds?: number;
    peakIntentWindowSeconds?: number;
    trackingEfficiencyScore?: number;
  };
}
