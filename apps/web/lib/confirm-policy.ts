'use client';

import { useQuery } from '@tanstack/react-query';
import { confirmPolicyApi } from '@/lib/api-client';

/**
 * Settings → Confirm it is you (0.49). The catalog and the values come from
 * GET /security/confirm-policy (apps/api/src/security-controls/confirm-catalog.ts
 * is the one copy); the console words its prompts from them, so a page never
 * claims a confirmation that a Platform Admin turned off.
 *
 * Fails the same way the API does: until the policy has loaded, or for a key
 * it does not list, a function is treated as asking. The API decides either
 * way — this only changes what the page says.
 */
export type ConfirmValue = 'ask' | 'off';
export interface ConfirmFunction {
  key: string;
  group: string;
  label: string;
  description: string;
  prompt: string;
  default: ConfirmValue;
  value: ConfirmValue;
}
export interface ConfirmPolicyView {
  groups: string[];
  catalog: ConfirmFunction[];
  values: Record<string, ConfirmValue>;
  alwaysAsk: string[];
  canChange: boolean;
}

export const CONFIRM_POLICY_QUERY = ['confirm-policy'] as const;

export function useConfirmPolicy() {
  return useQuery<ConfirmPolicyView>({
    queryKey: CONFIRM_POLICY_QUERY,
    queryFn: () => confirmPolicyApi.get().then((r) => r.data?.data),
    staleTime: 30_000,
    retry: false,
  });
}

/** Whether this function asks, by the view: true unless it says exactly 'off'. */
export function asks(view: ConfirmPolicyView | undefined, key: string): boolean {
  return view?.values?.[key] !== 'off';
}

/** Whether this function asks the signed-in person to confirm it is them. True while loading. */
export function useAsks(key: string): boolean {
  const { data } = useConfirmPolicy();
  return asks(data, key);
}

/** " (re-authenticate)" for a button whose function asks, nothing when it is off. */
export function reauthSuffix(ask: boolean): string {
  return ask ? ' (re-authenticate)' : '';
}

/** "You will be asked to confirm it is you." — or nothing when the function is off. */
export function confirmSentence(ask: boolean, sentence = 'You will be asked to confirm it is you.'): string {
  return ask ? sentence : '';
}
