/**
 * Resolve OCI credentials and the launch target for the real-cloud scripts.
 *
 * Precedence is environment first, then `~/.oci/config` — the same file
 * `image/build.sh` already expects via OCI_CONFIG_FILE/OCI_PROFILE. Reading it
 * means the smoke scripts work with the setup a Packer build already needs,
 * instead of asking for the same four values a second time under new names.
 *
 * Nothing here prints. OCIDs are identifiers rather than secrets, but the key
 * material this touches is neither logged nor echoed.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OciCredentials } from '../src/adapters/compute.ts';

export function readOciConfigFile(profile = process.env.OCI_PROFILE ?? 'DEFAULT'): Record<string, string> {
  const path = process.env.OCI_CONFIG_FILE ?? join(homedir(), '.oci', 'config');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  let inProfile = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inProfile = trimmed === `[${profile}]`;
      continue;
    }
    if (!inProfile || !trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

export interface ResolvedOci {
  credentials: OciCredentials;
  region: string;
  compartmentOcid: string;
}

export function resolveOci(): ResolvedOci {
  const config = readOciConfigFile();
  const keyPath = (process.env.OCI_PRIVATE_KEY_PATH ?? config.key_file ?? '').replace(/^~/, homedir());
  if (!keyPath) throw new Error('no OCI private key: set OCI_PRIVATE_KEY_PATH or key_file in ~/.oci/config');
  const tenancyOcid = process.env.OCI_TENANCY_OCID ?? config.tenancy ?? '';
  const credentials: OciCredentials = {
    tenancyOcid,
    userOcid: process.env.OCI_USER_OCID ?? config.user ?? '',
    fingerprint: process.env.OCI_KEY_FINGERPRINT ?? config.fingerprint ?? '',
    privateKeyPem: readFileSync(keyPath, 'utf8'),
  };
  for (const [field, value] of Object.entries(credentials)) {
    if (!value) throw new Error(`OCI credential is missing: ${field}`);
  }
  const region = process.env.OCI_REGION ?? config.region ?? '';
  if (!region) throw new Error('no OCI region: set OCI_REGION or region in ~/.oci/config');
  return {
    credentials,
    region,
    // The tenancy is the root compartment, which is where the pilot's fleet lives.
    compartmentOcid: process.env.OCI_COMPARTMENT_OCID ?? tenancyOcid,
  };
}

/**
 * The newest image the Packer build recorded. Defaulting to it means the smoke
 * verifies the image that was actually last built, rather than whichever OCID
 * someone happened to leave in their shell.
 */
export function latestBuiltImageOcid(): string | null {
  if (process.env.OCI_WORKSPACE_IMAGE_OCID) return process.env.OCI_WORKSPACE_IMAGE_OCID;
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '.artifacts', 'packer-manifest.json'), 'utf8')) as {
      builds?: Array<{ artifact_id?: string; build_time?: number }>;
    };
    const newest = (manifest.builds ?? []).filter(build => build.artifact_id).sort((a, b) => (a.build_time ?? 0) - (b.build_time ?? 0)).pop();
    // artifact_id is "<region>:<ocid>".
    return newest?.artifact_id?.split(':').pop() ?? null;
  } catch {
    return null;
  }
}
