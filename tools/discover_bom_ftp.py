#!/usr/bin/env python3
"""Read-only discovery of BOM anonymous FTP Victorian warning products.

No scraping, no downloads, and no automated scheduling. Prints names only.
"""
from ftplib import FTP, all_errors
import sys

HOST = 'ftp.bom.gov.au'
PATH = '/anon/gen/fwo'


def main():
    try:
        with FTP(HOST, timeout=25) as ftp:
            ftp.login('anonymous', 'anonymous@')
            ftp.set_pasv(True)
            ftp.cwd(PATH)
            names = ftp.nlst()
            vic = sorted(n for n in names if n.rsplit('/', 1)[-1].upper().startswith('IDV'))
            print(f'Connected to {HOST}{PATH}')
            print(f'Victorian IDV products currently present: {len(vic)}')
            print('Warning products may be absent when no warning is active.')
            print('Potential warning product names (discovery only, not validated):')
            for name in vic:
                base = name.rsplit('/', 1)[-1]
                if any(word in base.lower() for word in ('warn', 'marine', 'coast')):
                    print(' ', base)
            print('\nFor full product IDs, consult the BOM anonymous FTP product catalogue.')
            print('Do not infer no warnings from an empty listing.')
    except all_errors as exc:
        print(f'FTP unavailable: {exc}', file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
