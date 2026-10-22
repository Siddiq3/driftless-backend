import { v1 } from '@siddiq3/driftless-contracts';
import { summarizeWrap, wrapBounds, localDateOf } from '@siddiq3/driftless-contracts/domain';
import { Errors, HttpError, json, validate } from '../lib/http.js';
import { loadOrCreateProfile } from './me.js';
import { getUsageHistory } from './usage.js';
/** Only existing opted-in day totals are read; no raw sessions, timestamps or peer profiles. */
export async function getWrapped(event, caller) {
  const query = validate(v1.WrapQuery, event.queryStringParameters ?? {});
  const profile = await loadOrCreateProfile(caller.sub);
  if (!profile.consent.cloudSync)
    throw new HttpError(403, 'consent_required', 'cloud sync is off for this account');
  if (query.end >= localDateOf(Date.now(), profile.tz))
    throw Errors.badRequest('Choose a completed period');
  const bounds = wrapBounds(query.period, query.end);
  const history = await getUsageHistory(
    { ...event, queryStringParameters: { from: bounds.previousFrom, to: bounds.to } },
    caller,
  );
  const rows = v1.HistoryResponse.parse(JSON.parse(history.body)).days;
  return json(
    200,
    v1.WrapResponse.parse({ ...summarizeWrap(query.period, query.end, rows), source: 'synced' }),
  );
}
