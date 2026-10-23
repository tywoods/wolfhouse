#!/usr/bin/env python3
"""Deduplicated /data threshold alert. Credentials come only from env or a file reference."""
import argparse,json,os,shutil,urllib.request
from pathlib import Path
THREAD_ID='1537017482748100678'
def level(used_pct,available_gib):
 if used_pct>=90 or available_gib<15:return 'red'
 if used_pct>=85:return 'yellow'
 return 'ok'
def maybe_send(current,message,state_file,sender):
 previous=''
 try:previous=state_file.read_text().strip()
 except OSError:pass
 if current==previous:return False
 if current!='ok':sender(message)
 state_file.parent.mkdir(parents=True,exist_ok=True); state_file.write_text(current+'\n');return True
def token():
 if os.environ.get('DISCORD_BOT_TOKEN'):return os.environ['DISCORD_BOT_TOKEN'].strip()
 ref=os.environ.get('DISCORD_BOT_TOKEN_FILE')
 if ref:return Path(ref).read_text().strip()
 raise RuntimeError('set DISCORD_BOT_TOKEN or DISCORD_BOT_TOKEN_FILE')
def send(message):
 req=urllib.request.Request(f'https://discord.com/api/v10/channels/{THREAD_ID}/messages',data=json.dumps({'content':message}).encode(),headers={'Authorization':'Bot'+' '+token(),'Content-Type':'application/json'},method='POST')
 with urllib.request.urlopen(req,timeout=15) as r:
  if r.status//100!=2:raise RuntimeError(f'Discord HTTP {r.status}')
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--path',default='/data'); ap.add_argument('--state-file',default='/var/lib/dev01-disk-guard/alert-state'); ap.add_argument('--print-only',action='store_true'); a=ap.parse_args()
 usage=shutil.disk_usage(a.path); used=100*(usage.total-usage.free)/usage.total; avail=usage.free/1024**3; cur=level(used,avail); msg=f'DEV01 disk {cur.upper()}: {a.path} {used:.1f}% used, {avail:.1f} GiB available'
 maybe_send(cur,msg,Path(a.state_file),print if a.print_only else send)
if __name__=='__main__':main()
