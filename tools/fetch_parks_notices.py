#!/usr/bin/env python3
"""Ingest a RECENT listing of Parks Victoria notices. Never treat as complete extant-notice register."""
import os,re,json,datetime,urllib.request,urllib.parse
from html.parser import HTMLParser

ROOT='https://www.parks.vic.gov.au'
LIST=ROOT+'/mariners-notices'
WORKER=os.environ.get('WORKER_URL','https://kayaking-conditions.delicate-meadow-3eb1.workers.dev').rstrip('/')
NUMBER=re.compile(r'(?i)\b(?:No\.?\s*)?(\d{1,4})\s*(\(T\))?\s*[-– ]\s*(20\d\d)\b')
PATH=re.compile(r'^/mariners-notices/20\d\d/\d\d/\d\d/')

class Links(HTMLParser):
 def __init__(self):super().__init__();self.href=None;self.buf=[];self.items=[]
 def handle_starttag(self,tag,attrs):
  if tag=='a':self.href=dict(attrs).get('href');self.buf=[]
 def handle_data(self,data):
  if self.href is not None:self.buf.append(data)
 def handle_endtag(self,tag):
  if tag=='a' and self.href is not None:self.items.append((self.href,' '.join(''.join(self.buf).split())));self.href=None

def fetch(url):
 req=urllib.request.Request(url,headers={'User-Agent':'kayaking-conditions-notice-ingest/1.0','Accept':'text/html'})
 with urllib.request.urlopen(req,timeout=25) as r:
  if r.status!=200:raise RuntimeError(f'HTTP {r.status}: {url}')
  return r.read(2_000_000).decode('utf-8','replace')

def normalise(s):
 m=NUMBER.search(s)
 return f'{int(m.group(1)):03d}{"(T)" if m.group(2) else ""}-{m.group(3)}' if m else None

def main():
 token=os.environ.get('BOM_INGEST_TOKEN')
 if not token:raise RuntimeError('Missing BOM_INGEST_TOKEN GitHub secret')
 links=Links();links.feed(fetch(LIST))
 candidates={}
 for href,label in links.items:
  url=urllib.parse.urljoin(ROOT,href)
  parsed=urllib.parse.urlparse(url)
  if parsed.netloc not in ('www.parks.vic.gov.au','parks.vic.gov.au') or not PATH.match(parsed.path):continue
  number=normalise(label+' '+parsed.path.split('/')[-1].replace('-',' '))
  if number:candidates[number]=(url,label)
 if len(candidates)<10:raise RuntimeError('Parks listing unexpectedly short; refusing to ingest incomplete snapshot')
 # Recent listing only: inspect titles and cancellation text for Patterson River and nearby Carrum waters.
 selected={k:v for k,v in candidates.items() if re.search(r'patterson|carrum|mordialloc|port phillip|beaumaris',v[1],re.I)}
 # Cancellation notices may have unrelated titles, so fetch all recent detail pages (bounded).
 if len(candidates)>120:raise RuntimeError('Unexpectedly large listing; review pagination before ingest')
 items=[]
 for number,(url,title) in candidates.items():
  html=fetch(url)
  plain=re.sub(r'<[^>]+>',' ',html)
  plain=re.sub(r'\s+',' ',plain)
  relevant=number in selected or bool(re.search(r'Patterson River|Carrum Foreshore|Carrum Beach|Mordialloc Creek',title,re.I))
  # Only inspect cancellation references in the labelled Previous notice section.
  m=re.search(r'Previous\s+notice\s*:?(.{0,450}?)(?:Charts\s*&|Further\s+Notice|Details\s*:|Attachments\s*:)',plain,re.I)
  cancels=[]
  if m:
   section=m.group(1)
   if re.search(r'cancelled|canceled',section,re.I):cancels=list(dict.fromkeys(filter(None,(normalise(x.group(0)) for x in NUMBER.finditer(section)))))
  # Also include notices that cancel an already relevant notice.
  items.append(dict(number=number,title=title or number,url=url,cancels=cancels,category='patterson' if re.search(r'patterson river',title,re.I) else 'nearby',detail_verified=True,include=relevant))
 relevant_numbers={x['number'] for x in items if x['include']}
 relevant_items=[{k:v for k,v in x.items() if k!='include'} for x in items if x['include'] or any(c in relevant_numbers for c in x['cancels'])]
 if not relevant_items:raise RuntimeError('No local notices discovered; refuse silent clear')
 body=json.dumps(dict(source=LIST,coverage='recent_listing',fetched_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),notices=relevant_items)).encode()
 req=urllib.request.Request(WORKER+'/api/local/notices/ingest',data=body,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'kayaking-conditions-notice-ingest/1.0'},method='POST')
 with urllib.request.urlopen(req,timeout=30) as r:print(r.read().decode())

if __name__=='__main__':main()
