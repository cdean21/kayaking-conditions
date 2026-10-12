#!/usr/bin/env python3
import ftplib, json, os, sys, urllib.request

HOST='ftp.bom.gov.au'; DIR='/anon/gen/fwo'
FILES=('IDV20600.xml','IDV10460.xml')
WORKER_URL='https://kayaking-conditions.delicate-meadow-3eb1.workers.dev/api/bom/ingest'
token=os.environ.get('BOM_INGEST_TOKEN')
if not token:
    raise SystemExit('BOM_INGEST_TOKEN is not set')

ftp=ftplib.FTP(HOST, timeout=25)
try:
    ftp.login()
    ftp.cwd(DIR)
    products={}
    for name in FILES:
        chunks=[]
        ftp.retrbinary('RETR '+name, chunks.append)
        products[name]=b''.join(chunks).decode('utf-8')
finally:
    try: ftp.quit()
    except Exception: ftp.close()

payload=json.dumps({'warning_xml':products['IDV20600.xml'],'forecast_xml':products['IDV10460.xml']}).encode()
req=urllib.request.Request(WORKER_URL,data=payload,method='POST',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'kayaking-conditions-bom-ingest/1.0'})
try:
    with urllib.request.urlopen(req,timeout=25) as r:
        body=r.read().decode(); print(body)
        if r.status < 200 or r.status >= 300: raise SystemExit(1)
except Exception as e:
    print(f'BOM ingestion failed: {e}', file=sys.stderr); raise
