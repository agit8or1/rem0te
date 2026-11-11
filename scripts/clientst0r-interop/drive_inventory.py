"""Path A of the rem0te <-> ClientSt0r integration, run inside ClientSt0r.

ClientSt0r's RMM provider for rem0te (integrations/providers/rmm/rem0te.py)
syncs computers through rem0te's public API with a business-scoped API key.
This drives that provider's own code against a real rem0te: whoami, the
connection test, a full device list, normalisation, and the business pin
that stops a key for another business from filing its computers here.

Started by apps/api/scripts/interop-clientst0r.mjs with:
  REM0TE_URL, CS_API_KEY (Acme, computers:read), CS_API_KEY_OTHER (Birch),
  CS_REPORT (where to write the JSON report), DJANGO_SETTINGS_MODULE.
Writes nothing outside ClientSt0r's scratch sqlite and CS_REPORT.
"""
import json
import os
import traceback

import django

django.setup()

from core.models import Organization  # noqa: E402
from integrations.models import RMMConnection  # noqa: E402
from integrations.providers.rmm.rem0te import BUSINESS_PIN, Rem0teProvider  # noqa: E402

steps = []


def step(name, fn):
    try:
        steps.append({'step': name, 'ok': True, 'result': fn()})
    except Exception as e:  # recorded, not raised: the harness judges each step
        steps.append({'step': name, 'ok': False, 'error': f'{type(e).__name__}: {e}'[:600],
                      'trace': traceback.format_exc()[-800:]})


rem0te = os.environ['REM0TE_URL']
Organization.objects.filter(slug='interop-inventory').delete()
org = Organization.objects.create(name='Interop Inventory', slug='interop-inventory')
conn = RMMConnection(organization=org, provider_type='rem0te', name='rem0te (inventory)', base_url=rem0te)
conn.set_credentials({'api_key': os.environ['CS_API_KEY']})
conn.save()

provider = Rem0teProvider(conn)
step('whoami', lambda: provider.whoami())
step('test_connection', lambda: provider.test_connection())


def devices():
    out = []
    for n in provider.list_devices():  # already normalised by the provider
        out.append({k: n.get(k) for k in ('external_id', 'device_name', 'os_type', 'is_online', 'client_id',
                                           'client_name', 'site_name')})
    return out


step('list_devices', devices)
step('business_pinned', lambda: (RMMConnection.objects.get(pk=conn.pk).field_mappings or {}).get(BUSINESS_PIN))
step('console_url', lambda: Rem0teProvider.device_console_url(conn, type('D', (), {'external_id': 'abc'})()))

# The same connection given another business's key must stop, not re-file.
conn.refresh_from_db()
conn.set_credentials({'api_key': os.environ['CS_API_KEY_OTHER']})
conn.save()
step('other_business_key', lambda: Rem0teProvider(conn).list_devices())

with open(os.environ['CS_REPORT'], 'w') as f:
    json.dump({'steps': steps}, f, indent=2, default=str)
