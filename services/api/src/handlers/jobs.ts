import { reconcilePlay } from '../modules/billing/reconcile.js';

/** EventBridge-scheduled maintenance (daily). */
export const handler = async (): Promise<{ checked: number; changed: number }> => reconcilePlay();
