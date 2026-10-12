#!/usr/bin/env python3
"""Import human-checked BOM Williamstown tide events from CSV; never infer values.
CSV columns: local_date,local_time,event_type,height_m,source_year
Example: 2026-10-12,09:15,high,0.91,2026 (illustrative only; NOT real data)
"""
import argparse,csv,json,os,sys,urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

SOURCE='https://www.bom.gov.au/oceanography/projects/ntc/vic_tide_tables.shtml'
TZ=ZoneInfo('Australia/Melbourne')

def parse(path):
    events=[]
    with open(path,newline='',encoding='utf-8-sig') as f:
        reader=csv.DictReader(f)
        needed={'local_date','local_time','event_type','height_m','source_year'}
        if not needed.issubset(reader.fieldnames or []): raise ValueError('Missing CSV columns: '+', '.join(sorted(needed-set(reader.fieldnames or []))))
        for row in reader:
            if not any(row.values()):continue
            d=datetime.strptime(row['local_date']+' '+row['local_time'],'%Y-%m-%d %H:%M')
            if row['event_type'] not in ('high','low'):raise ValueError('event_type must be high or low')
            year=int(row['source_year']);height=float(row['height_m'])
            if d.year!=year or year not in (2026,2027) or not (-1<=height<=3):raise ValueError('Implausible year or height')
            aware=d.replace(tzinfo=TZ)
            # Reject nonexistent local wall times and ambiguous DST transition times.
            utc=aware.astimezone(ZoneInfo('UTC'))
            if utc.astimezone(TZ).replace(tzinfo=None)!=d or aware.replace(fold=0).utcoffset()!=aware.replace(fold=1).utcoffset():
                raise ValueError('DST ambiguous/nonexistent time: '+str(d))
            events.append(dict(reference_station='Melbourne (Williamstown)',event_at=aware.isoformat(),event_type=row['event_type'],height_m=height,datum='LAT',source_name='BOM National Tidal Unit',source_url=SOURCE,source_year=year))
    events.sort(key=lambda x:x['event_at'])
    if not events:raise ValueError('No tide events in CSV')
    if len({e['event_at'] for e in events})!=len(events):raise ValueError('Duplicate timestamps')
    for a,b in zip(events,events[1:]):
        if a['event_type']==b['event_type']:raise ValueError('Consecutive tide events have the same type; review source PDF')
        delta=(datetime.fromisoformat(b['event_at'])-datetime.fromisoformat(a['event_at'])).total_seconds()/3600
        if not 1<=delta<=12:raise ValueError('Unusual gap between events; review source PDF')
    return events

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('csv',help='Manually verified CSV transcribed from official BOM PDF')
    p.add_argument('--send',action='store_true',help='POST to Worker after review')
    p.add_argument('--worker',default='https://kayaking-conditions.delicate-meadow-3eb1.workers.dev')
    args=p.parse_args()
    events=parse(args.csv)
    print(f'Validated {len(events)} events; first {events[0]["event_at"]}; last {events[-1]["event_at"]}')
    if not args.send:
        print('Dry run only. Compare CSV against BOM PDF; rerun with --send to import.')
        return
    token=os.environ.get('ADMIN_TOKEN')
    if not token:raise ValueError('Set ADMIN_TOKEN environment variable (do not paste token in chat)')
    for i in range(0,len(events),100):
        payload=json.dumps({'events':events[i:i+100]}).encode()
        req=urllib.request.Request(args.worker.rstrip('/')+'/api/fishing/tides',data=payload,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'kayaking-conditions-tide-import/1.0'},method='POST')
        with urllib.request.urlopen(req,timeout=25) as r:print(r.read().decode())

if __name__=='__main__':
    try:main()
    except Exception as exc:print('ERROR:',exc,file=sys.stderr);sys.exit(1)
