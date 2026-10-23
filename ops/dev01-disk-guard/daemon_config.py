#!/usr/bin/env python3
"""Prepare and validate a daemon.json with bounded json-file logs; never restarts Docker."""
import argparse,json
from pathlib import Path
def merge_config(src):
 out=dict(src); opts=dict(out.get('log-opts',{})); opts.update({'max-size':'20m','max-file':'3'}); out['log-driver']='json-file'; out['log-opts']=opts; return out
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('input'); ap.add_argument('output'); a=ap.parse_args()
 src=json.loads(Path(a.input).read_text()); out=merge_config(src); text=json.dumps(out,indent=2,sort_keys=True)+'\n'; json.loads(text); Path(a.output).write_text(text); print(a.output)
if __name__=='__main__':main()
