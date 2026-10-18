#!/usr/bin/env python3
import ftplib
import json
import os
import sys
import time
import urllib.error
import urllib.request

HOST = 'ftp.bom.gov.au'
DIR = '/anon/gen/fwo'
FILES = ('IDV20600.xml', 'IDV10460.xml')
WORKER_URL = 'https://kayaking-conditions.delicate-meadow-3eb1.workers.dev/api/bom/ingest'
FTP_TIMEOUT = 25
HTTP_TIMEOUT = 25
MAX_ATTEMPTS = 3
RETRY_DELAYS = (10, 30)

token = os.environ.get('BOM_INGEST_TOKEN')
if not token:
    raise SystemExit('BOM_INGEST_TOKEN is not set')


def download_products():
    """Download a complete BOM product set or fail closed.

    A fresh FTP connection is used for every attempt. This protects against
    transient 550/open-file failures while BOM rotates forecast products.
    Nothing is uploaded unless every required product is present and non-empty.
    """
    last_error = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        ftp = None
        products = {}
        try:
            print(f'BOM FTP attempt {attempt}/{MAX_ATTEMPTS}: connecting to {HOST}...', flush=True)
            ftp = ftplib.FTP(HOST, timeout=FTP_TIMEOUT)
            ftp.login()
            ftp.cwd(DIR)

            for name in FILES:
                print(f'Downloading {name}...', flush=True)
                chunks = []
                ftp.retrbinary('RETR ' + name, chunks.append)
                raw = b''.join(chunks)
                if not raw.strip():
                    raise RuntimeError(f'{name} downloaded successfully but was empty')
                products[name] = raw.decode('utf-8')
                print(f'Downloading {name}... OK ({len(raw):,} bytes)', flush=True)

            return products

        except (ftplib.all_errors, OSError, UnicodeDecodeError, RuntimeError) as exc:
            last_error = exc
            print(
                f'BOM FTP attempt {attempt}/{MAX_ATTEMPTS} failed: '
                f'{type(exc).__name__}: {exc}',
                file=sys.stderr,
                flush=True,
            )
        finally:
            if ftp is not None:
                try:
                    ftp.quit()
                except Exception:
                    try:
                        ftp.close()
                    except Exception:
                        pass

        if attempt < MAX_ATTEMPTS:
            delay = RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)]
            print(f'Retrying complete BOM product download in {delay} seconds...', flush=True)
            time.sleep(delay)

    raise RuntimeError(
        f'Could not download a complete BOM product set after {MAX_ATTEMPTS} attempts; '
        f'last error: {last_error}'
    )


def upload_products(products):
    missing = [name for name in FILES if not products.get(name)]
    if missing:
        raise RuntimeError('Refusing to ingest incomplete BOM product set: ' + ', '.join(missing))

    payload = json.dumps({
        'warning_xml': products['IDV20600.xml'],
        'forecast_xml': products['IDV10460.xml'],
    }).encode()

    req = urllib.request.Request(
        WORKER_URL,
        data=payload,
        method='POST',
        headers={
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'User-Agent': 'kayaking-conditions-bom-ingest/1.1',
        },
    )

    print('Uploading complete BOM product set to kayaking-conditions...', flush=True)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as response:
            body = response.read().decode()
            print(body)
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f'Worker returned HTTP {response.status}')
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode('utf-8', errors='replace')
        except Exception:
            body = ''
        raise RuntimeError(
            f'Worker ingest returned HTTP {exc.code}' + (f': {body}' if body else '')
        ) from exc


try:
    products = download_products()
    upload_products(products)
    print('BOM ingestion complete.', flush=True)
except Exception as exc:
    print(f'BOM ingestion failed: {type(exc).__name__}: {exc}', file=sys.stderr, flush=True)
    raise SystemExit(1)
