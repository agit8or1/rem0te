/**
 * v0.28: ActivityLog.seq is a BigInt (the audit chain's order), and
 * JSON.stringify throws on a BigInt ("Do not know how to serialize a BigInt").
 * Every process that may serialize an audit row imports this first: the API
 * and the integration worker. A BigInt becomes its decimal string.
 */
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) { return this.toString(); };
export {};
