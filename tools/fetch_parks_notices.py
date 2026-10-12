#!/usr/bin/env python3
"""Fetch recent Parks Victoria NTMs. Recent pages are NOT a complete active-notice register."""
import datetime
import json
import os
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser

ROOT = 'https://www.parks.vic.gov.au'
LIST = ROOT + '/mariners-notices'
WORKER = os.environ.get('WORKER_URL', 'https://kayaking-conditions.delicate-meadow-3eb1.workers.dev').rstrip('/')
PATH = re.compile(r'^/mariners-notices/20\d\d/\d\d/\d\d/', re.I)
NUMBER = re.compile(r'(?i)\b(?:No\.?\s*)?(\d{1,4})\s*(\(T\))?\s*[-– ]\s*(20\d{2}|\d{2})\b')
LOCAL = re.compile(r'\b(?:Patterson\s+River|Carrum(?:\s+(?:Foreshore|Beach|Creek))?|Mordialloc(?:\s+Creek)?)\b', re.I)

class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.href = None
        self.buf = []
        self.items = []
    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.href = dict(attrs).get('href')
            self.buf = []
    def handle_data(self, data):
        if self.href is not None:
            self.buf.append(data)
    def handle_endtag(self, tag):
        if tag == 'a' and self.href is not None:
            self.items.append((self.href, ' '.join(''.join(self.buf).split())))
            self.href = None

def fetch(url):
    request = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; kayaking-conditions-notice-ingest/1.1)',
        'Accept': 'text/html',
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f'HTTP {response.status}: {url}')
        return response.read(2_000_000).decode('utf-8', 'replace')

def normalise(value):
    match = NUMBER.search(value)
    if not match:
        return None
    year = match.group(3)
    if len(year) == 2:
        year = '20' + year
    return f'{int(match.group(1)):03d}{"(T)" if match.group(2) else ""}-{year}'

def text_from_html(html):
    html = re.sub(r'(?is)<(?:script|style)\b[^>]*>.*?</(?:script|style)>', ' ', html)
    html = re.sub(r'(?s)<[^>]*>', ' ', html)
    return ' '.join(__import__('html').unescape(html).split())

def candidates_on_page(html):
    parser = Links()
    parser.feed(html)
    found = {}
    for href, label in parser.items:
        url = urllib.parse.urljoin(ROOT, href)
        parsed = urllib.parse.urlparse(url)
        if parsed.netloc not in ('parks.vic.gov.au', 'www.parks.vic.gov.au') or not PATH.match(parsed.path):
            continue
        number = normalise(label + ' ' + parsed.path.split('/')[-1].replace('-', ' '))
        if number:
            found[number] = (url, label)
    return found

def main():
    token = os.environ.get('BOM_INGEST_TOKEN')
    if not token:
        raise RuntimeError('Missing BOM_INGEST_TOKEN GitHub secret')

    # The official site paginates ten notices at a time. Read several pages so
    # relevant local notices are not hidden behind unrelated recent notices.
    candidates = {}
    for page in range(1, 9):
        url = LIST + '?' + urllib.parse.urlencode({'page': page, 'pageSize': 10})
        found = candidates_on_page(fetch(url))
        if not found:
            if page == 1:
                raise RuntimeError('Parks listing contains no parseable notice links')
            break
        before = len(candidates)
        candidates.update(found)
        if len(candidates) == before:
            break
    if len(candidates) < 20:
        raise RuntimeError(f'Only {len(candidates)} notice links found; refusing incomplete snapshot')
    print(f'Discovered {len(candidates)} recent notices across paginated listing', flush=True)

    items = []
    for number, (url, label) in candidates.items():
        plain = text_from_html(fetch(url))
        # The listing's anchor label is just "No. 457 - 2026". The subject and
        # locality are on the detail page, so inspect the detail content.
        match = re.search(r'(?i)\bDetails\s*:', plain)
        before_details = plain[:match.start()] if match else plain
        # Include the notice's subject, location and details, but avoid footer
        # text and unrelated navigation links.
        end = re.search(r'(?i)\b(?:Previous\s+notice|Charts\s*&|Further\s+Notice|Attachments)\s*:', plain)
        relevant_text = plain[:end.start()] if end else plain[:2500]
        relevant = bool(LOCAL.search(relevant_text))
        previous = re.search(r'(?i)\bPrevious\s+notice\s*:\s*(.*?)(?=\b(?:Charts\s*&|Further\s+Notice|Attachments)\s*:|$)', plain)
        cancels = []
        if previous and re.search(r'cancelled|canceled', previous.group(1), re.I):
            cancels = list(dict.fromkeys(filter(None, (normalise(m.group(0)) for m in NUMBER.finditer(previous.group(1))))))
        # Preserve the actual notice identifier and URL. Do not infer an active
        # status or clear launch suitability from this limited recent listing.
        items.append({
            'number': number,
            'title': label or number,
            'url': url,
            'cancels': cancels,
            'category': 'patterson' if re.search(r'Patterson\s+River', relevant_text, re.I) else 'nearby',
            'detail_verified': True,
            '_relevant': relevant,
        })

    relevant_numbers = {x['number'] for x in items if x['_relevant']}
    selected = [{k: v for k, v in x.items() if k != '_relevant'} for x in items
                if x['_relevant'] or any(c in relevant_numbers for c in x['cancels'])]
    print(f'Found {len(selected)} relevant local/cancellation notices', flush=True)
    if not selected:
        raise RuntimeError('No local notices discovered; refuse silent clear')
    payload = json.dumps({
        'source': LIST,
        'coverage': 'recent_listing',
        'fetched_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'notices': selected,
    }).encode()
    request = urllib.request.Request(
        WORKER + '/api/local/notices/ingest', data=payload, method='POST',
        headers={
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'User-Agent': 'kayaking-conditions-notice-ingest/1.1',
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        print(response.read().decode())

if __name__ == '__main__':
    main()
