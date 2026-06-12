#!/usr/bin/env python3
"""Read Fragrantica HTML from stdin, print the freshest valid Algolia search key.

The key is embedded inline in window.fragranticaRuntime as a base64 string that
decodes to "<hash>validUntil=<unix_ts>". Prints an empty string if none is found
or all are expired.
"""
import sys
import re
import base64
import time

html = sys.stdin.read()
best = None
for cand in set(re.findall(r'[A-Za-z0-9+/]{80,}={0,2}', html)):
    try:
        decoded = base64.b64decode(cand + '===').decode('utf-8', 'replace')
    except Exception:
        continue
    m = re.search(r'validUntil=(\d+)', decoded)
    if m:
        ts = int(m.group(1))
        if ts > time.time() and (best is None or ts > best[1]):
            best = (cand, ts)

print(best[0] if best else '')
