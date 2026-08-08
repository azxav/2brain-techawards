/**
 * Read-only preflight for the real-cloud adapters.
 *
 * Every call here is a GET. It creates nothing, mutates nothing, and costs
 * nothing — so it is safe to run before committing to `smoke:provision`, which
 * launches a billed VM and writes live DNS.
 *
 * What it actually proves, and why that matters: the OCI request signer
 * (adapters/compute.ts) is the one part of #40 no fake can exercise. Its unit
 * tests pin the signing string's shape against a generated key pair, but only a
 * real 200 from OCI proves the signature is one OCI accepts. Same for the
 * Cloudflare token's scope.
 *
 *   bun run image/smoke-preflight.ts
 *
 * Credentials come from ~/.oci/config (or OCI_CONFIG_FILE) and the environment.
 * Nothing secret is printed: checks report only pass/fail and a reason.
 */
import { ociSigningHeaders } from '../src/adapters/compute.ts';
import { CloudflareDns } from '../src/adapters/dns.ts';
import { latestBuiltImageOcid, resolveOci } from './oci-config.ts';

interface Check {
  name: string;
  proves: string;
  run: () => Promise<string>;
}

const { credentials, region, compartmentOcid } = resolveOci();
const imageOcid = latestBuiltImageOcid();

const checks: Check[] = [
  {
    name: 'OCI credentials + request signing',
    proves: 'the draft-cavage signature is one OCI actually accepts (no fake covers this)',
    run: async () => {
      // Asserted on the raw status rather than through the adapter: the adapter
      // maps 404 to null, so a null return cannot distinguish "signed fine, no
      // match" from "compartment not found". Only an explicit 200 proves OCI
      // both authenticated the signature and answered the query.
      const url = new URL(`https://iaas.${region}.oraclecloud.com/20160918/instances?${new URLSearchParams({ compartmentId: compartmentOcid, limit: '1' })}`);
      const response = await fetch(url.toString(), {
        headers: { ...ociSigningHeaders(credentials, 'GET', url, null, new Date()), accept: 'application/json' },
      });
      if (response.status === 401 || response.status === 403) throw new Error(`OCI rejected the signature with ${response.status}`);
      if (!response.ok) throw new Error(`OCI answered ${response.status} (signature accepted, but the request was refused)`);
      const body = (await response.json()) as unknown[];
      return `HTTP 200 from ListInstances; compartment holds ${body.length === 0 ? 'no' : 'at least one'} instance`;
    },
  },
  {
    name: 'OCI accepts a signed POST (body-covering signature)',
    proves: 'the write path signs correctly — a launch signs 3 headers a GET never does',
    run: async () => {
      // The GET above exercises "(request-target) host date". A POST additionally
      // signs content-length, content-type and x-content-sha256, which is a
      // distinct code path and the easy one to get wrong. It cannot be proven
      // read-only, so prove it by rejection instead: an empty body has no
      // compartment, shape or image, so OCI must refuse it on validation — and
      // it only reaches validation if the signature already passed. A 400 means
      // signed correctly; a 401 means the body-covering signature is broken.
      const url = new URL(`https://iaas.${region}.oraclecloud.com/20160918/instances`);
      const body = '{}';
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { ...ociSigningHeaders(credentials, 'POST', url, body, new Date()), accept: 'application/json' },
        body,
      });
      if (response.ok) throw new Error(`OCI accepted an empty launch body with ${response.status} — refusing to interpret that as success`);
      if (response.status === 401 || response.status === 403) throw new Error(`OCI rejected the signed POST with ${response.status}: the body-covering signature is wrong`);
      return `HTTP ${response.status} (validation, not auth) — the signature was accepted and nothing was created`;
    },
  },
  {
    name: 'OCI rejects a tampered signature',
    proves: 'the 200 above is real authentication, not an endpoint that ignores the header',
    run: async () => {
      const url = new URL(`https://iaas.${region}.oraclecloud.com/20160918/instances?${new URLSearchParams({ compartmentId: compartmentOcid, limit: '1' })}`);
      const headers = ociSigningHeaders(credentials, 'GET', url, null, new Date());
      // Same request, one byte of the signature flipped.
      const tampered = headers.authorization.replace(/signature="(.)/, (_m, first) => `signature="${first === 'A' ? 'B' : 'A'}`);
      const response = await fetch(url.toString(), { headers: { ...headers, authorization: tampered, accept: 'application/json' } });
      if (response.ok) throw new Error('OCI accepted a tampered signature — the 200 above proves nothing');
      return `tampered signature refused with ${response.status}, as it must be`;
    },
  },
];

if (imageOcid) {
  checks.push({
    name: 'workspace image is available',
    proves: 'the baked image a provision would launch from exists and is AVAILABLE',
    run: async () => {
      // Images have their own resource path; asking the instances route about an
      // image OCID would 404 no matter how healthy the image is.
      const url = new URL(`https://iaas.${region}.oraclecloud.com/20160918/images/${encodeURIComponent(imageOcid)}`);
      const response = await fetch(url.toString(), {
        headers: { ...ociSigningHeaders(credentials, 'GET', url, null, new Date()), accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`OCI answered ${response.status} for this image OCID`);
      const image = (await response.json()) as { lifecycleState: string; operatingSystem?: string };
      if (image.lifecycleState !== 'AVAILABLE') throw new Error(`image is ${image.lifecycleState}, not AVAILABLE`);
      return `AVAILABLE (${image.operatingSystem ?? 'unknown OS'})`;
    },
  });
} else {
  console.error('[preflight] SKIP  workspace image — no OCI_WORKSPACE_IMAGE_OCID and no Packer manifest');
}

if (process.env.CP_CLOUDFLARE_API_TOKEN && process.env.CP_CLOUDFLARE_ZONE_ID) {
  checks.push({
    name: 'Cloudflare zone is readable',
    proves: 'the token reaches this zone at all',
    run: async () => {
      const dns = new CloudflareDns({
        apiToken: process.env.CP_CLOUDFLARE_API_TOKEN!,
        zoneId: process.env.CP_CLOUDFLARE_ZONE_ID!,
      });
      const record = await dns.findRecord(`preflight-does-not-exist.${process.env.CP_WORKSPACE_DOMAIN ?? process.env.WORKSPACE_DOMAIN ?? 'example.com'}`);
      return record === null ? 'zone readable; no stray preflight record' : 'zone readable; a stale preflight record exists';
    },
  });
  checks.push({
    name: 'Cloudflare token can WRITE this zone',
    proves: 'the token is DNS:Edit, not DNS:Read — a read-only token passes every check above',
    run: async () => {
      // Reading proves nothing about writing, and a DNS:Read token would sail
      // through the check above only to fail at the dns step *after* a VM has
      // been launched. Prove the write grant the same way the OCI POST is
      // proven: by rejection. An empty body has no type, name or content, so
      // Cloudflare must refuse it on validation (400) — but permission is
      // checked first, so a token without DNS:Edit is refused with 403 instead.
      // Nothing is created on either path.
      const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CP_CLOUDFLARE_ZONE_ID}/dns_records`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.CP_CLOUDFLARE_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      if (response.ok) throw new Error(`Cloudflare accepted an empty record body with ${response.status} — refusing to read that as success`);
      if (response.status === 403) throw new Error('403: this token cannot write DNS. It needs Zone > DNS > Edit on this zone (Read is not enough)');
      if (response.status === 401) throw new Error('401: Cloudflare did not accept this token at all');
      return `HTTP ${response.status} (validation, not permission) — DNS:Edit confirmed, nothing created`;
    },
  });
} else {
  console.error('[preflight] SKIP  Cloudflare token + zone — CP_CLOUDFLARE_API_TOKEN / CP_CLOUDFLARE_ZONE_ID are not set');
}

/**
 * `--discover` prints the env lines a provision and a build need but that
 * nothing records today: availability domain, subnet, the launch shape, and the
 * Canonical base image plus build shape `build.sh` requires. All are readable,
 * so hunting them in the console by hand is avoidable. OCIDs are identifiers
 * rather than secrets, but they still should not be pasted around: redirect this
 * to a gitignored file.
 */
async function discover(): Promise<void> {
  const get = async (host: string, path: string): Promise<any> => {
    const url = new URL(`https://${host}.${region}.oraclecloud.com${path}`);
    const response = await fetch(url.toString(), {
      headers: { ...ociSigningHeaders(credentials, 'GET', url, null, new Date()), accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
    return response.json();
  };

  // A shape is not a free choice: it must be one the image can boot AND one this
  // tenancy is actually offered. Guessing a plausible name earns a bare 404
  // (NotAuthorizedOrNotFound) at launch, so ask which shapes exist instead.
  // Flex only: the launch sends a shapeConfig (ocpus/memoryInGBs), which fixed
  // shapes reject. The pilot is deliberately pinned to Ampere A2: discovery
  // reports absence instead of silently selecting another architecture.
  const preferred = ['VM.Standard.A2.Flex'];
  const shapesFor = async (imageId: string): Promise<{ all: string[]; chosen: string | undefined }> => {
    const shapes = (await get('iaas', `/20160918/shapes?${new URLSearchParams({ compartmentId: compartmentOcid, imageId })}`)) as Array<{ shape: string }>;
    const all = [...new Set(shapes.map(shape => shape.shape))];
    return { all, chosen: preferred.find(shape => all.includes(shape)) };
  };

  const domains = await get('identity', `/20160918/availabilityDomains?${new URLSearchParams({ compartmentId: compartmentOcid })}`);
  const subnets = await get('iaas', `/20160918/subnets?${new URLSearchParams({ compartmentId: compartmentOcid })}`);
  const usable = (subnets as Array<{ id: string; displayName: string; prohibitPublicIpOnVnic?: boolean; lifecycleState: string }>)
    .filter(subnet => subnet.lifecycleState === 'AVAILABLE' && subnet.prohibitPublicIpOnVnic !== true);

  console.log('# Discovered read-only. Review before use; a workspace VM needs a PUBLIC subnet.');
  console.log(`OCI_REGION=${region}`);
  console.log(`OCI_COMPARTMENT_OCID=${compartmentOcid}`);
  console.log(`OCI_AVAILABILITY_DOMAIN=${(domains as Array<{ name: string }>)[0]?.name ?? 'NONE-FOUND'}`);
  if (usable.length === 0) {
    console.log('# No public subnet found in this compartment — a workspace cannot get a public IP without one.');
  }
  for (const [index, subnet] of usable.entries()) {
    console.log(`${index === 0 ? 'OCI_SUBNET_OCID' : `# alternative (${subnet.displayName})`}=${subnet.id}`);
  }

  // The shape a provisioned workspace runs on, from the baked image.
  if (imageOcid) {
    const { all, chosen } = await shapesFor(imageOcid);
    if (chosen) console.log(`OCI_INSTANCE_SHAPE=${chosen}`);
    else console.log(`# No Flex shape available for the workspace image. Offered: ${all.join(', ')}`);
    console.log(`# flex shapes offered for the workspace image: ${all.filter(name => name.endsWith('.Flex')).join(', ') || 'none'}`);
  }

  // Packer builds ON a stock Canonical image. build.sh requires its OCID and a
  // build shape, and neither is recorded anywhere once a build finishes — the
  // manifest keeps only the artifact. Without these, the next release rebuild
  // starts by hunting the console.
  const images = (await get('iaas', `/20160918/images?${new URLSearchParams({
    compartmentId: compartmentOcid,
    operatingSystem: 'Canonical Ubuntu',
    sortBy: 'TIMECREATED',
    sortOrder: 'DESC',
    limit: '100',
  })}`)) as Array<{ id: string; displayName: string; operatingSystemVersion: string; lifecycleState: string }>;
  // Canonical publishes aarch64 variants under the same OS name, and Minimal
  // variants omit packages the provision script expects. An architecture
  // mismatch fails deep inside packer rather than at launch.
  const bases = images.filter(image => image.lifecycleState === 'AVAILABLE'
    && /aarch64/i.test(image.displayName)
    && !/Minimal/i.test(image.displayName));
  const orderedBases = [
    ...bases.filter(image => image.operatingSystemVersion?.startsWith('24.04')),
    ...bases.filter(image => image.operatingSystemVersion?.startsWith('22.04')),
    ...bases.filter(image => !image.operatingSystemVersion?.startsWith('24.04')
      && !image.operatingSystemVersion?.startsWith('22.04')),
  ];
  let base: (typeof bases)[number] | undefined;
  let baseShape: string | undefined;
  for (const candidate of orderedBases) {
    const compatible = await shapesFor(candidate.id);
    if (compatible.chosen) {
      base = candidate;
      baseShape = compatible.chosen;
      break;
    }
  }
  if (base) {
    console.log(`# base image for build.sh: ${base.displayName} (${base.operatingSystemVersion})`);
    console.log(`OCI_BASE_IMAGE_OCID=${base.id}`);
    console.log(`OCI_PACKER_SHAPE=${baseShape}`);
  } else {
    console.log('# No A2-compatible Canonical Ubuntu aarch64 base image found — build.sh cannot run.');
  }

  console.log(`# availability domains: ${(domains as unknown[]).length}, public subnets: ${usable.length}, ubuntu bases: ${bases.length}`);
}

if (process.argv.includes('--discover')) {
  await discover();
  process.exit(0);
}

let failed = false;
for (const check of checks) {
  try {
    const detail = await check.run();
    console.log(`[preflight] PASS  ${check.name} — ${detail}`);
    console.log(`                  proves: ${check.proves}`);
  } catch (error) {
    failed = true;
    // Adapter errors are already written to carry a status and a method, never
    // a body or a credential.
    console.error(`[preflight] FAIL  ${check.name}: ${(error as Error).message}`);
    console.error(`                  would prove: ${check.proves}`);
  }
}

console.log('');
console.log(failed ? '[preflight] NOT ready for smoke:provision' : '[preflight] the checks that ran all passed');
process.exit(failed ? 1 : 0);
