/**
 * Read-only CLOB authentication for the connectivity check (`check-polymarket --with-credentials`): signs the
 * L1 header for `GET /auth/derive-api-key` and L2 headers for GET requests with clob-client's own header
 * builders. Only the two header functions are imported (ESLint allows nothing else from clob-client here):
 * this module cannot build a ClobClient, post, cancel or create anything.
 *
 * The private key stays in the signer; the headers carry signatures and the API key, and the caller only sends
 * them. Importing the credential redaction keeps clob-client's axios errors (if anything here ever goes
 * through it) free of auth headers.
 */

import './redactCredentials';
import { ethers } from 'ethers';
import { createL1Headers, createL2Headers } from '@polymarket/clob-client';
import type { ClobApiCreds, ClobAuthProbe } from '../../ops/connectivityCheck';

const POLYGON = 137;

export function createClobReadOnlyAuth(privateKey: string, label: string): ClobAuthProbe {
  const signer = new ethers.Wallet(privateKey);
  const asRecord = (h: object): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)]));
  return {
    label,
    l1Headers: async () => asRecord(await createL1Headers(signer, POLYGON)),
    l2Headers: async (creds: ClobApiCreds, method: 'GET', requestPath: string) => asRecord(await createL2Headers(signer, creds, { method, requestPath })),
  };
}
