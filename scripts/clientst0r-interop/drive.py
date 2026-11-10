"""
Runs INSIDE a disposable ClientSt0r (its own Django, sqlite) and drives
ClientSt0r's real ticket-RMM code against a running rem0te. Writes a JSON
report of what each step did. It changes nothing in rem0te or in the
ClientSt0r checkout: the database is a scratch sqlite file named by
CS_INTEROP_DB, and logs go to CS_INTEROP_LOG_DIR.

Invoked by apps/api/scripts/interop-clientst0r.mjs; see
docs/contracts/ticket-rmm-v1/CLIENTST0R.md.
"""
import json
import os
import sys

import django

django.setup()

from django.test import Client  # noqa: E402

from core.models import Organization  # noqa: E402
from integrations.models import RMMConnection  # noqa: E402
from integrations import ticket_rmm  # noqa: E402
from psa_ai.services import processor  # noqa: E402

out = {'clientst0r_dir': os.getcwd(), 'steps': []}


def step(name, **kw):
    out['steps'].append({'step': name, **kw})


rem0te = os.environ['REM0TE_URL']
# A reused CS_INTEROP_DB keeps earlier runs' rows: start from a clean organization.
Organization.objects.filter(slug='interop-acme').delete()
org = Organization.objects.create(name='Interop Acme', slug='interop-acme')
conn = RMMConnection(organization=org, provider_type='rem0te', name='rem0te (interop)', base_url=rem0te)
conn.set_credentials({ticket_rmm.OUTBOUND: os.environ['CS_OUTBOUND_SECRET'], ticket_rmm.INBOUND: os.environ['CS_INBOUND_SECRET']})
conn.field_mappings = {ticket_rmm.ENABLED: True, ticket_rmm.KEY_ID: os.environ['CS_KEY_ID'], ticket_rmm.LOCATION: 'local'}
conn.save()
s = ticket_rmm.settings(conn)
step('pairing configured', enabled=s['enabled'], site=s['site'], location=s['location'], key_id=s['key_id'])

# 1. ClientSt0r's own capability discovery, against the live rem0te.
res = processor.refresh_capabilities(conn)
conn.refresh_from_db()
step('refresh_capabilities (ClientSt0r signs with HMAC)', result=res, stored=(conn.field_mappings or {}).get(ticket_rmm.CAPS))

# 2. Suppose the signature were accepted: hand ClientSt0r's parser the
#    document rem0te really returns (fetched with Ed25519 by the runner).
doc = json.load(open(os.environ['REM0TE_CAPABILITIES']))
conn2 = RMMConnection(organization=org, provider_type='rem0te', name='rem0te (parser)', base_url=rem0te)
conn2.set_credentials({ticket_rmm.OUTBOUND: 'x' * 32, ticket_rmm.INBOUND: 'y' * 32})
conn2.field_mappings = {ticket_rmm.ENABLED: True, ticket_rmm.KEY_ID: 'k', ticket_rmm.LOCATION: 'local'}
conn2.save()
rec = ticket_rmm.record_capabilities(conn2, doc)
step('record_capabilities(rem0te\'s real capabilities document)', result=rec)

# 3. rem0te's signed job event, delivered to ClientSt0r's events endpoint.
ex = json.load(open(os.environ['REM0TE_EVENT_EXAMPLE']))
c = Client(HTTP_HOST='127.0.0.1')
extra = {f"HTTP_{k.upper().replace('-', '_')}": v for k, v in ex['request']['headers'].items() if k != 'content-type'}
r = c.post('/api/integration/v1/events', data=json.dumps(ex['request']['body']), content_type='application/json', **extra)
body = r.content.decode('utf-8', 'replace')[:500]
step('POST /api/integration/v1/events with rem0te\'s signed event', status=r.status_code, body=body)

# 4. The job ClientSt0r would submit, by the keys processor.job_payload builds.
step('processor.job_payload keys', keys=['contract', 'job_id', 'kind', 'correlation_id', 'idempotency_key', 'organization_id', 'business_id', 'ticket{id,ref,revision}', 'actor{id,delegation}', 'endpoint', 'profiles[{id,name,provider,location}]', 'evidence_digest', 'processing_location', 'expires_at', 'inference_url', 'events_url'])

json.dump(out, open(os.environ['CS_INTEROP_REPORT'], 'w'), indent=2, default=str)
print('ok')
sys.exit(0)
