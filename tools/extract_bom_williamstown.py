#!/usr/bin/env python3
"""Extract BOM 2026 Melbourne (Williamstown) tide predictions to review CSV.

Requires: pip install pdfplumber
Usage: python3 tools/extract_bom_williamstown.py williamstown_2026.pdf

The parser uses PDF word coordinates rather than reconstructed text lines because
BOM prints four months per page with two half-month columns per month.
"""
import argparse,csv,calendar,re
from datetime import datetime
from zoneinfo import ZoneInfo

TZ=ZoneInfo('Australia/Melbourne')
TIME=re.compile(r'^\d{4}$')
HEIGHT=re.compile(r'^\d+\.\d{2}$')


def extract(path):
 import pdfplumber
 raw=[]
 with pdfplumber.open(path) as pdf:
  if len(pdf.pages)!=4: raise ValueError('Expected 4 pages (terms + 3 tide-data pages)')
  for pi,page in enumerate(pdf.pages[1:]):
   text=page.extract_text() or ''
   if 'MELBOURNE (WILLIAMSTOWN)' not in text.upper() or '2026' not in text:
    raise ValueError(f'Unexpected station/year on PDF page {pi+2}')
   words=page.extract_words(x_tolerance=1.5,y_tolerance=2.5)
   # Fixed visual layout: eight half-month columns across each tide-data page.
   # Boundaries are midway between the observed column starts and are stable
   # across all three pages of this BOM product.
   bounds=[28,92,160,227,294,361,428,495,566]
   for col in range(8):
    month=pi*4+col//2+1
    lo,hi=bounds[col],bounds[col+1]
    ws=[w for w in words if lo <= w['x0'] < hi and 95 <= w['top'] <= 790]
    # Date numbers sit at the left edge of each half-month column; tide times
    # sit ~11-25 pt to their right. This distinction prevents 0000/0015 etc.
    # from ever being mistaken for day numbers.
    date_x_max=lo+22
    dates=[]
    for w in ws:
     s=w['text'].strip()
     if w['x0'] <= date_x_max and s.isdigit():
      d=int(s)
      first_half=(col%2==0)
      if (first_half and 1<=d<=15) or ((not first_half) and 16<=d<=31):
       if d<=calendar.monthrange(2026,month)[1]: dates.append((float(w['top']),d))
    # Deduplicate date labels while preserving y position.
    dd={}
    for y,d in dates: dd[d]=y
    dates=sorted((y,d) for d,y in dd.items())
    expected_days=range(1,16) if col%2==0 else range(16,calendar.monthrange(2026,month)[1]+1)
    missing=[d for d in expected_days if d not in dd]
    if missing: raise ValueError(f'Page {pi+2}, month {month}: missing day labels {missing}')

    # Pair time and height tokens that share a baseline. Ignore headings and
    # moon/day-of-week text. x-order identifies time followed by height.
    rows={}
    for w in ws:
     y=round(float(w['top']),1); rows.setdefault(y,[]).append(w)
    pairs=[]
    for y,row in rows.items():
     row=sorted(row,key=lambda z:z['x0'])
     for i,w in enumerate(row[:-1]):
      t=w['text'].strip(); h=row[i+1]['text'].strip()
      if TIME.match(t) and HEIGHT.match(h) and w['x0']>date_x_max-3:
       hh,mm=int(t[:2]),int(t[2:])
       height=float(h)
       if hh<=23 and mm<=59 and 0<=height<=2.5:
        pairs.append((y,t,height))
        break
    for y,t,h in pairs:
     # Day marker is printed on one of the day's tide rows, not necessarily the
     # first. Nearest y-position is therefore the reliable association.
     prior=[yd for yd in dates if yd[0] <= y+0.2]
     if not prior: raise ValueError(f'No preceding day label for month {month}, event {t} at y={y}')
     _,d=max(prior,key=lambda yd:yd[0])
     dt=datetime(2026,month,d,int(t[:2]),int(t[2:]))
     raw.append((dt,h))

 # Validate every calendar day and remove no data silently.
 byday={}
 for dt,h in raw: byday.setdefault(dt.date(),[]).append((dt,h))
 expected=sum(calendar.monthrange(2026,m)[1] for m in range(1,13))
 if len(byday)!=expected:
  missing=[]
  for m in range(1,13):
   for d in range(1,calendar.monthrange(2026,m)[1]+1):
    if datetime(2026,m,d).date() not in byday: missing.append(f'{m:02d}-{d:02d}')
  raise ValueError(f'Only {len(byday)}/{expected} days parsed; missing {missing[:20]}. DO NOT IMPORT.')
 for day,vals in sorted(byday.items()):
  if len(vals) not in (2,3,4,5): raise ValueError(f'{day}: unexpected {len(vals)} tide events')

 events=sorted(raw)
 if len(set(events))!=len(events): raise ValueError('Duplicate tide events detected')

 # Infer H/L from neighboring predicted heights and verify strict alternation.
 output=[]
 for i,(dt,height) in enumerate(events):
  if i==0:
   kind='high' if height>events[1][1] else 'low'
  elif i==len(events)-1:
   kind='high' if height>events[-2][1] else 'low'
  else:
   before,after=events[i-1][1],events[i+1][1]
   if height>before and height>after: kind='high'
   elif height<before and height<after: kind='low'
   else: raise ValueError(f'Non-alternating extrema near {dt}: {before}, {height}, {after}')
  aware=dt.replace(tzinfo=TZ)
  if aware.replace(fold=0).utcoffset()!=aware.replace(fold=1).utcoffset() or aware.astimezone(ZoneInfo('UTC')).astimezone(TZ).replace(tzinfo=None)!=dt:
   raise ValueError(f'DST ambiguity/nonexistent local time at {dt}; manual review required')
  output.append({'local_date':dt.strftime('%Y-%m-%d'),'local_time':dt.strftime('%H:%M'),'event_type':kind,'height_m':f'{height:.2f}','source_year':'2026'})

 for a,b in zip(output,output[1:]):
  if a['event_type']==b['event_type']: raise ValueError(f'Same consecutive extrema at {a} / {b}')
  t1=datetime.fromisoformat(a['local_date']+'T'+a['local_time']).replace(tzinfo=TZ)
  t2=datetime.fromisoformat(b['local_date']+'T'+b['local_time']).replace(tzinfo=TZ)
  hours=(t2.astimezone(ZoneInfo('UTC'))-t1.astimezone(ZoneInfo('UTC'))).total_seconds()/3600
  if not 1<=hours<=12: raise ValueError(f'Implausible event gap {hours:.2f}h at {t2}')
 return output


def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('pdf'); p.add_argument('--out',default='williamstown_2026_REVIEW.csv')
 args=p.parse_args(); rows=extract(args.pdf)
 with open(args.out,'w',newline='',encoding='utf-8') as f:
  w=csv.DictWriter(f,fieldnames=['local_date','local_time','event_type','height_m','source_year']); w.writeheader(); w.writerows(rows)
 print(f'Extracted {len(rows)} validated turning-point events into {args.out}.')
 print(f'First: {rows[0]}')
 print(f'Last:  {rows[-1]}')
 print('Review sample dates against the BOM PDF before importing.')

if __name__=='__main__': main()
