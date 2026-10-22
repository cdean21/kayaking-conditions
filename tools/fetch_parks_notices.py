#!/usr/bin/env python3
"""Fetch recent Parks Victoria NTMs. Recent pages are NOT a complete active-notice register."""
import datetime
import json
from pathlib import Path
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

ROOT = 'https://www.parks.vic.gov.au'
LIST = ROOT + '/mariners-notices'
WORKER = os.environ.get('WORKER_URL', 'https://kayaking-conditions.delicate-meadow-3eb1.workers.dev').rstrip('/')
PATH = re.compile(r'^/mariners-notices/20\d\d/\d\d/\d\d/', re.I)
NUMBER = re.compile(r'(?i)\b(?:No\.?\s*)?(\d{1,4})\s*(\(T\))?\s*[-– ]\s*(20\d{2}|\d{2})\b')
# Bound the whole scrape; a slow provider must not hang the scheduled job.
SCRAPE_BUDGET_SECONDS = 10 * 60
REQUEST_TIMEOUT_SECONDS = 35
RETRY_DELAYS_SECONDS = (3, 8)
STARTED_AT = time.monotonic()
CACHE = {}
CACHE_FILE = Path(os.environ.get('PARKS_NOTICE_CACHE_FILE', '.cache/parks-notices/details.json'))
CACHE_TTL_SECONDS = 24 * 60 * 60
CACHE_SCHEMA = 1
CACHE_DIRTY = False


def load_detail_cache():
    """Cache is only a bandwidth optimization, never evidence of a successful fetch."""
    try:
        data = json.loads(CACHE_FILE.read_text())
        if data.get('schema') != CACHE_SCHEMA or not isinstance(data.get('pages'), dict):
            raise ValueError('unsupported cache schema')
        return data['pages']
    except (OSError, ValueError, TypeError) as exc:
        print(f'No usable previous detail cache ({exc}); full refresh', flush=True)
        return {}


DETAIL_CACHE = load_detail_cache()


def detail_page(url, force_refresh=False):
    global CACHE_DIRTY
    if not force_refresh:
        entry = DETAIL_CACHE.get(url)
        if isinstance(entry, dict):
            age = time.time() - entry.get('fetched_at', 0) if isinstance(entry.get('fetched_at'), (int, float)) else float('inf')
            body = entry.get('html')
            if 0 <= age < CACHE_TTL_SECONDS and isinstance(body, str) and body.strip() and len(body) <= 2_000_000:
                return body, True
    body = fetch(url)  # No stale-cache fallback when a required request fails.
    DETAIL_CACHE[url] = {'fetched_at': time.time(), 'html': body}
    CACHE_DIRTY = True
    return body, False


def save_detail_cache(urls):
    # Only called AFTER the Worker has acknowledged the complete snapshot.
    selected = {url: DETAIL_CACHE[url] for url in urls if url in DETAIL_CACHE}
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps({'schema': CACHE_SCHEMA, 'pages': selected}, separators=(',', ':')))
    tmp.replace(CACHE_FILE)
    print(f'Updated detail cache: {len(selected)} pages', flush=True)
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

def remaining_budget():
    remaining = SCRAPE_BUDGET_SECONDS - (time.monotonic() - STARTED_AT)
    if remaining <= 0:
        raise RuntimeError('Parks Victoria scrape exceeded 10-minute overall budget; refusing partial ingest')
    return remaining


def fetch(url):
    if url in CACHE:
        return CACHE[url]

    request = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; kayaking-conditions-notice-ingest/1.1)',
        'Accept': 'text/html',
    })
    for attempt in range(1, len(RETRY_DELAYS_SECONDS) + 2):
        timeout = min(REQUEST_TIMEOUT_SECONDS, remaining_budget())
        print(f'GET {url} (attempt {attempt}/3, timeout {timeout:.0f}s)', flush=True)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise RuntimeError(f'HTTP {response.status}: {url}')
                body = response.read(2_000_001)
                if len(body) > 2_000_000:
                    raise RuntimeError(f'Oversized Parks Victoria response: {url}')
                if not body:
                    raise RuntimeError(f'Empty Parks Victoria response: {url}')
                result = body.decode('utf-8', 'replace')
                CACHE[url] = result
                return result
        except urllib.error.HTTPError as exc:
            # Permanent client errors should not be retried. Rate limits and
            # server errors may clear after a short pause.
            if exc.code != 429 and not (500 <= exc.code <= 599):
                raise RuntimeError(f'Parks Victoria HTTP {exc.code}: {url}') from exc
            error = exc
        except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError, OSError) as exc:
            error = exc
        except RuntimeError:
            # Empty/oversized/invalid responses are not transient network failures.
            raise

        print(f'Parks Victoria fetch failed: {type(error).__name__}: {error}', flush=True)
        if attempt > len(RETRY_DELAYS_SECONDS):
            raise RuntimeError(f'Parks Victoria fetch failed after 3 attempts: {url}') from error
        delay = min(RETRY_DELAYS_SECONDS[attempt - 1], remaining_budget())
        print(f'Retrying in {delay:.0f}s...', flush=True)
        time.sleep(delay)


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


def classify_notice(text, cancels):
    # A notice that explicitly says the work/hazard is complete and cancels
    # earlier notices is a resolution notice. Check this BEFORE hazard keywords:
    # resolution notices often repeat words such as dredging/shoaling while
    # describing the condition that has now ended.
    resolved_language = re.search(
        r'(?i)\b(?:completed|complete|concluded|finished|restored|reinstated|'
        r'no longer in effect|cancelled|canceled)\b', text
    )
    # Notice 394-2026: the submerged car was removed and 388(T)-2026
    # explicitly cancelled. 'Removed' describes resolution of that particular
    # obstruction, not a new hazard. Do not generalise to every supersession.
    obstruction_removed = re.search(
        r'(?i)\b(?:submerged\s+car|submerged\s+vehicle)\b.{0,180}\bremoved\b',
        text
    )
    if cancels and (resolved_language or obstruction_removed):
        return 'resolved'

    # Classification is deliberately conservative. Only explicit closure,
    # exclusion, depth/entrance or obstruction language becomes a hard block.
    if re.search(r'(?i)\b(?:closed|closure|prohibited|exclusion zone|do not enter|unsafe to navigate|shoal(?:ing)?|insufficient depth|reduced depth|dredg(?:ing|e)|obstruction|navigation hazard)\b', text):
        return 'blocking'
    if re.search(r'(?i)\b(?:missing|unlit|damaged|off station|unserviceable)\b.{0,80}\b(?:buoy|beacon|navigation mark|special mark|light)\b|\b(?:buoy|beacon|navigation mark|special mark|light)\b.{0,80}\b(?:missing|unlit|damaged|off station|unserviceable)\b', text):
        return 'caution'
    return 'review'

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
    fetched = reused = refreshed_local = 0
    for number, (url, label) in candidates.items():
        remaining_budget()
        # Always refresh previously local notices: changes to restrictions,
        # cancellation language or details must not be hidden by caching.
        prior = DETAIL_CACHE.get(url)
        prior_html = prior.get('html', '') if isinstance(prior, dict) else ''
        was_local = bool(LOCAL.search(text_from_html(prior_html)[:2500])) if prior_html else False
        html, from_cache = detail_page(url, force_refresh=was_local)
        if from_cache:
            reused += 1
        else:
            fetched += 1
            refreshed_local += int(was_local)
        plain = text_from_html(html)
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
            'category': ('carrum' if re.search(r'\bCarrum\b', relevant_text, re.I) else 'patterson' if re.search(r'Patterson\s+River', relevant_text, re.I) else 'mordialloc' if re.search(r'\bMordialloc\b', relevant_text, re.I) else 'nearby'),
            'detail_verified': True,
            'assessment': classify_notice(relevant_text, cancels),
            '_relevant': relevant,
        })

    relevant_numbers = {x['number'] for x in items if x['_relevant']}
    selected = [{k: v for k, v in x.items() if k != '_relevant'} for x in items
                if x['_relevant'] or any(c in relevant_numbers for c in x['cancels'])]
    print(f'Detail pages: {fetched} downloaded ({refreshed_local} previously local), {reused} reused from <24h cache', flush=True)
    print(f'Found {len(selected)} relevant local/cancellation notices', flush=True)
    if not selected:
        raise RuntimeError('No local notices discovered; refuse silent clear')
    remaining_budget()
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
        response_body = response.read().decode()
        print(response_body)
        # Do not persist a cache if ingestion was rejected.
        if response.status != 200 or not json.loads(response_body).get('ok'):
            raise RuntimeError('Worker did not confirm successful Parks notice ingestion')
    save_detail_cache([url for url, _ in candidates.values()])

if __name__ == '__main__':
    main()
