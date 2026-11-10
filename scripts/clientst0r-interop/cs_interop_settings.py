# Interop-only overlay for a disposable ClientSt0r: sqlite, logs in scratch.
import os
from config.settings import *  # noqa: F401,F403
from config import settings as _base
_logdir = os.environ['CS_INTEROP_LOG_DIR']
for _h in LOGGING.get('handlers', {}).values():  # noqa: F405
    if _h.get('class') == 'logging.FileHandler':
        _h['filename'] = os.path.join(_logdir, os.path.basename(_h['filename']))
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': os.environ['CS_INTEROP_DB']}}
ALLOW_PRIVATE_IP_INTEGRATIONS = True
