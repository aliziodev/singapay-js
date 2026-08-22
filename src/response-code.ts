/**
 * SingaPay `response_code` values — the "SP" codes carried by v2 envelopes.
 *
 * Kept as a const object rather than a TypeScript `enum` so the published
 * types stay structural and tree-shakeable, and so an unrecognized code from a
 * future gateway release is still representable as a plain string.
 */
export const ResponseCode = {
  Success: 'SP000',
  TransactionFailure: 'SP001',
  GeneralFailure: 'SP002',
  InsufficientBalance: 'SP003',
  DuplicateReferenceNumber: 'SP004',
  Timeout: 'SP005',
  ExceedBeneficiaryLimit: 'SP006',
  ExceedAccountLimit: 'SP007',
  InvalidReferenceNumber: 'SP008',
  TransactionNotFound: 'SP009',
  BeneficiaryAccountNotFound: 'SP010',
  BeneficiaryVendorNotActive: 'SP011',
  BadRequest: 'SP012',
  Unauthorized: 'SP013',
  NotFound: 'SP014',
  Forbidden: 'SP015',
  SignatureInvalid: 'SP016',
  UnauthorizedIp: 'SP017',
  ValidationError: 'SP018',
  GeneralError: 'SP019',
  MerchantAccountNotFound: 'SP020',
  AccountCredentialRequired: 'SP403',
} as const;

export type ResponseCodeValue = (typeof ResponseCode)[keyof typeof ResponseCode];

/**
 * Codes whose outcome is genuinely unknown.
 *
 * After one of these the transaction may or may not have gone through. Call
 * the endpoint `inquireStatus()` with the same reference number before doing
 * anything else — a blind retry can duplicate a real transfer.
 *
 * This is about *writes*. On a read there is no outcome to reconcile, and the
 * SDK already retries an idempotent request that fails at the transport level;
 * `SP005` on a `GET` means nothing more than a slow gateway.
 */
export function shouldInquireStatus(code: string | null): boolean {
  return code === ResponseCode.TransactionFailure || code === ResponseCode.Timeout;
}

/** Codes meaning the access token is stale and should be fetched again once. */
export function requiresTokenRefresh(code: string | null): boolean {
  return code === ResponseCode.Unauthorized;
}
