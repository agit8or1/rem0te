import { Injectable } from '@nestjs/common';
import { SignerClient } from './signer.client';

/**
 * One read-only question for the script library (0.40): is the approval
 * signer's DEFAULT policy in direct mode?
 *
 * The library may let a version's author review it only then — the same
 * setting under which the signer adds a proposed version to its allowlist at
 * once, which is the step that actually decides whether it can run. The
 * library imports this and nothing else of the signer's (§ 23): it can ask
 * this one question, and cannot propose, sign or read anything.
 *
 * Any failure (no signer configured, unreachable, an unexpected answer) is
 * "no": the independent review stays required.
 */
@Injectable()
export class ApprovalModeProbe {
  private readonly signer = new SignerClient();

  async allowlistDirect(): Promise<boolean> {
    if (!this.signer.configured()) return false;
    try {
      const r = await this.signer.policy('default');
      return r.status === 200 && r.body.approval === 'direct';
    } catch {
      return false;
    }
  }
}
