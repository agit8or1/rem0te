/** Badge variants for a patch deployment's status (v0.27). */
export const DEPLOYMENT_STATUS: Record<string, 'success' | 'warning' | 'outline' | 'secondary'> = {
  ACTIVE: 'secondary', PAUSED: 'warning', COMPLETED: 'success', CANCELED: 'outline',
};
