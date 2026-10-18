#!/usr/bin/env python3
import ftplib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HOST = 'ftp.bom.gov.au'
DIR = '/anon/gen/fwo'
WARNING_FILE = 'IDV20600.xml'
FORECAST_FILE = 'IDV10460.xml'
WARNINGS_URL = 'https://www.bom.gov.au/marine/marine_warnings.shtml'
WORKER_URL = 'https://kayaking-conditions.delicate-meadow-3eb1.workers.dev/api/bom/ingest'
RETRY_DELAYS = (10, 30)
USER_AGENT = 'kayaking-conditions-bom-ingest/1.1'

token = os.environ.get('BOM_INGEST_TOKEN')
if not token:
    raise SystemExit('BOM_INGEST_TOKEN is not set')


def retrieve(ftp, name):
    chunks = []
    ftp.retrbinary('RETR ' + name, chunks.append)
    raw = b''.join(chunks)
    if not raw.strip():
        raise RuntimeError(f'{name}: downloaded file is empty')
    return raw.decode('utf-8')


def download_products():
    """Forecast is mandatory. A 550 for the conditional warning product is handled separately."""
    last_error = None
    for attempt in range(1, 4):
        ftp = None
        try:
            print(f'BOM FTP attempt {attempt}/3: connecting to {HOST}...')
            ftp = ftplib.FTP(HOST, timeout=25)
            ftp.login()
            ftp.cwd(DIR)

            warning_xml = None
            warning_missing = False
            print(f'Downloading {WARNING_FILE}...')
            try:
                warning_xml = retrieve(ftp, WARNING_FILE)
                print(f'Downloading {WARNING_FILE}... OK')
            except ftplib.error_perm as exc:
                if str(exc).startswith('550'):
                    warning_missing = True
                    print(f'{WARNING_FILE} is not currently published (FTP 550).')
                else:
                    raise

            print(f'Downloading {FORECAST_FILE}...')
            forecast_xml = retrieve(ftp, FORECAST_FILE)
            print(f'Downloading {FORECAST_FILE}... OK')
            return warning_xml, warning_missing, forecast_xml
        except ftplib.all_errors + (OSError, UnicodeDecodeError, RuntimeError) as exc:
            last_error = exc
            print(f'BOM FTP attempt {attempt}/3 failed: {type(exc).__name__}: {exc}', file=sys.stderr)
            if attempt < 3:
                delay = RETRY_DELAYS[attempt - 1]
                print(f'Retrying complete BOM product download in {delay} seconds...', file=sys.stderr)
                time.sleep(delay)
        finally:
            if ftp is not None:
                try:
                    ftp.quit()
                except Exception:
                    try:
                        ftp.close()
                    except Exception:
                        pass

    raise RuntimeError(f'Could not download the mandatory BOM product set after 3 attempts; last error: {last_error}')


def verify_no_victorian_marine_warning():
    """Use BOM's official Marine Warnings page as independent evidence when IDV20600 is absent."""
    req = urllib.request.Request(WARNINGS_URL, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=25) as response:
        if response.status != 200:
            raise RuntimeError(f'BOM warnings page returned HTTP {response.status}')
        html = response.read().decode('utf-8', errors='replace')

    # Bound the check to the Victoria section so another state's "No warnings" cannot satisfy it.
    sections = re.findall(r'Victoria(?P<section>[\s\S]{0,5000}?)Queensland', html, re.I)
    if not sections:
        raise RuntimeError('Could not identify any Victoria section on the BOM Marine Warnings page')

    verified = False
    for raw_section in sections:
        section = re.sub(r'<[^>]+>', ' ', raw_section)
        section = re.sub(r'&nbsp;|&#160;', ' ', section, flags=re.I)
        section = re.sub(r'\s+', ' ', section).strip()
        if re.search(r'No\s+Marine\s+Warnings\s+Current\.?', section, re.I):
            verified = True
            break

    if not verified:
        raise RuntimeError(
            'IDV20600 is absent, but the BOM Marine Warnings page does not '
            'explicitly report "No Marine Warnings Current" in its Victoria section'
        )

    checked_at = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    print('BOM Marine Warnings page confirms: Victoria — No Marine Warnings Current.')
    return {
        'status': 'verified_no_current_victorian_marine_warning',
        'state': 'Victoria',
        'checked_at': checked_at,
        'source_url': WARNINGS_URL,
        'source': 'Bureau of Meteorology Marine Warnings page'
    }


def main():
    warning_xml, warning_missing, forecast_xml = download_products()
    warning_evidence = None
    if warning_missing:
        # Missing IDV20600 is only accepted after a second official BOM source explicitly confirms no VIC warning.
        warning_evidence = verify_no_victorian_marine_warning()

    payload = json.dumps({
        'warning_xml': warning_xml,
        'warning_evidence': warning_evidence,
        'forecast_xml': forecast_xml
    }).encode()
    req = urllib.request.Request(
        WORKER_URL,
        data=payload,
        method='POST',
        headers={
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            body = response.read().decode()
            print(body)
            if response.status < 200 or response.status >= 300:
                raise SystemExit(1)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8', errors='replace')
        print(f'Worker ingestion failed: HTTP {exc.code}: {body}', file=sys.stderr)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'BOM ingestion failed: {type(exc).__name__}: {exc}', file=sys.stderr)
        raise
