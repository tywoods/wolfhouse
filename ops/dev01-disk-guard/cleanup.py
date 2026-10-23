#!/usr/bin/env python3
"""Fail-closed /data scratch cleaner. Default mode only prints a plan."""
import argparse, json, os, re, shutil, stat, subprocess, time
from pathlib import Path

DENY_PARTS={'state.db','sessions','memories','auth','SOUL.md','SOUL','config'}
class Config:
 def __init__(self,root,now=None,protect_regex='',in_use=None,pr_states=None,proc_root=Path('/proc')):
  self.root=Path(root); self.now=time.time() if now is None else now; self.protect_regex=protect_regex; self.in_use=set(in_use or ()); self.pr_states=dict(pr_states or {}); self.proc_root=Path(proc_root)
class Decision:
 def __init__(self,path,action,reason,allowed_root=None,days=None): self.path=Path(path); self.action=action; self.reason=reason; self.allowed_root=Path(allowed_root) if allowed_root is not None else None; self.days=days
 def as_dict(self): return {'path':str(self.path),'action':self.action,'reason':self.reason}

def run(cmd): return subprocess.run(cmd,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def proc_targets(proc_root=Path('/proc')):
 out=set()
 for proc in proc_root.glob('[0-9]*'):
  for link in [proc/'cwd',*list((proc/'fd').glob('*'))]:
   try: out.add(os.readlink(link).split(' (deleted)')[0])
   except OSError: pass
 return out

def _container_path(candidate,root):
 try:
  rel=candidate.relative_to(root/'bots'); bot,*rest=rel.parts
  return Path('/opt/data').joinpath(*rest)
 except (ValueError,IndexError): return None
def is_in_use(candidate,root,targets):
 candidate=candidate.resolve(); cp=_container_path(candidate,root)
 try: host=Path('/data')/candidate.relative_to(root)
 except ValueError: host=candidate
 for raw in targets:
  p=Path(raw)
  for base in (candidate,host,cp):
   if base is None: continue
   try:
    if p==base or p.is_relative_to(base): return True
   except (ValueError,OSError): pass
 return False

def protected(path,regex):
 for part in path.parts:
  low=part.lower()
  if part in DENY_PARTS or low.startswith('.env') or low in {'home','.grok'}: return True
 return bool(regex and re.search(regex,str(path),re.I))
def protected_descendant(path,regex):
 try:
  for child in path.rglob('*'):
   if protected(child.relative_to(path),regex): return True
 except OSError:return True
 return False

def tree_old(path,cutoff):
 try:
  if path.stat().st_mtime>=cutoff:return False
  return not any(p.stat().st_mtime>=cutoff for p in path.rglob('*'))
 except OSError:return False

def _repo_safe(repo):
 s=run(['git','-C',str(repo),'status','--porcelain']);
 if s.returncode:return False,'giterr'
 if s.stdout.strip():return False,'dirty'
 st=run(['git','-C',str(repo),'stash','list']);
 if st.returncode or st.stdout.strip():return False,'stash'
 up=run(['git','-C',str(repo),'rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}'])
 if up.returncode:return False,'unknown-upstream'
 ancestor=run(['git','-C',str(repo),'merge-base','--is-ancestor','HEAD','@{upstream}'])
 if ancestor.returncode:return False,'unpushed-or-unknown-ancestry'
 ahead=run(['git','-C',str(repo),'rev-list','--count','@{upstream}..HEAD'])
 if ahead.returncode or ahead.stdout.strip()!='0':return False,'unpushed'
 return True,'merged-clean'
def git_safe(path):
 marker=path/'.git'
 if marker.is_file():
  try:
   text=marker.read_text().strip(); target=text.split('gitdir:',1)[1].strip(); gp=Path(target)
   if not gp.is_absolute():gp=(path/gp).resolve()
   if not gp.exists():return False,'broken-worktree-gitdir'
  except Exception:return False,'invalid-worktree-gitdir'
 repos=[]
 if marker.exists(): repos.append(path)
 try:
  repos += [p.parent for p in path.rglob('.git') if p.parent!=path]
 except OSError:return False,'git-scan-error'
 if not repos:return True,'non-git'
 for repo in repos:
  ok,why=_repo_safe(repo)
  if not ok:return False,why
 return True,'all-git-merged-clean'

def candidates(root):
 specs=[]
 def children(base,days):
  if base.exists(): specs.extend((p,days) for p in base.iterdir())
 children(root/'bots/hermes-captain/artifacts',3)
 children(root/'bots/hermes-orchestrator/artifacts',7)
 children(root/'bots/hermes-orchestrator/worktrees',7)
 ws=root/'bots/hermes-orchestrator/workspace'
 if ws.exists():
  for p in ws.iterdir():
   if p.name in {'sandbox-repos','releases'}:continue
   specs.append((p,7))
  sr=ws/'sandbox-repos'
  if sr.exists(): specs += [(p,7) for p in sr.iterdir() if p.name!='WH-orchestrator']
  rel=ws/'releases'
  if rel.exists():
   ordered=sorted(rel.iterdir(),key=lambda p:p.stat().st_mtime,reverse=True)
   specs += [(p,7 if i>=3 else -1) for i,p in enumerate(ordered)]
 for bot in ('hermes-deckhand','hermes-seadog'):
  children(root/f'bots/{bot}/workspace',7)
 return specs

def build_plan(cfg):
 out=[]
 for path,days in candidates(cfg.root):
  action='skip'; reason='fail-closed'
  if days<0:reason='newest-three-releases'
  elif protected(path,cfg.protect_regex):reason='protected'
  elif protected_descendant(path,cfg.protect_regex):reason='protected-descendant'
  elif is_in_use(path,cfg.root,cfg.in_use):reason='in-use'
  elif not tree_old(path,cfg.now-days*86400):reason='too-new-or-new-descendant'
  else:
   m=re.search(r'review-pr(\d+)',path.name,re.I)
   if m and cfg.pr_states.get(m.group(1),'UNKNOWN').upper() not in {'CLOSED','MERGED'}:reason='pr-open-or-unknown'
   else:
    ok,reason=git_safe(path)
    if ok:action='delete'
  out.append(Decision(path,action,reason,cfg.root,days))
 return out

def within_allowed_root(path,root):
 try:
  root=Path(root).absolute(); path=Path(path).absolute(); rel=path.relative_to(root)
  current=root
  for part in rel.parts[:-1]:
   current=current/part
   if current.is_symlink():return False
  return path.resolve(strict=True).is_relative_to(root.resolve(strict=True))
 except (OSError,ValueError):return False

def secure_delete(path,root,cfg=None):
 fds=[]; claimed=None; parent_fd=None; name=None
 try:
  root=Path(root).absolute(); path=Path(path).absolute(); rel=path.relative_to(root)
  if not rel.parts:return False
  flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
  fd=os.open(root,flags); fds.append(fd)
  for part in rel.parts[:-1]:
   fd=os.open(part,flags,dir_fd=fd); fds.append(fd)
  parent_fd=fd; name=rel.parts[-1]; mode=os.stat(name,dir_fd=fd,follow_symlinks=False).st_mode
  if stat.S_ISLNK(mode):return False
  claimed=f'.dev01-delete-{os.getpid()}-{time.time_ns()}'
  os.rename(name,claimed,src_dir_fd=fd,dst_dir_fd=fd)
  claimed_path=path.with_name(claimed)
  if cfg is not None:
   targets=proc_targets(cfg.proc_root)
   unsafe=(not within_allowed_root(claimed_path,root)
           or protected(path,cfg.protect_regex)
           or protected_descendant(claimed_path,cfg.protect_regex)
           or is_in_use(path,cfg.root,targets)
           or is_in_use(claimed_path,cfg.root,targets))
   if unsafe:
    os.rename(claimed,name,src_dir_fd=fd,dst_dir_fd=fd); claimed=None
    return False
  if stat.S_ISDIR(mode):shutil.rmtree(claimed,dir_fd=fd)
  else:os.unlink(claimed,dir_fd=fd)
  claimed=None
  return True
 except (OSError,ValueError):
  if claimed is not None and parent_fd is not None and name is not None:
   try:os.rename(claimed,name,src_dir_fd=parent_fd,dst_dir_fd=parent_fd)
   except OSError:pass
  return False
 finally:
  for fd in reversed(fds):os.close(fd)

def execute(plan,apply=False,cfg=None):
 for d in plan:
  if apply and d.action=='delete' and (d.allowed_root is None or not within_allowed_root(d.path,d.allowed_root)):
   d=Decision(d.path,'skip','outside-allowed-root',d.allowed_root,d.days)
  elif apply and d.action=='delete':
   current=Config(cfg.root,cfg.now,cfg.protect_regex,proc_targets(cfg.proc_root),cfg.pr_states,cfg.proc_root) if cfg is not None else None
   fresh=next((x for x in build_plan(current) if x.path==d.path),None) if current is not None else None
   if fresh is None:d=Decision(d.path,'skip','revalidation-unavailable',d.allowed_root,d.days)
   else:d=fresh
   if d.action=='delete' and not within_allowed_root(d.path,d.allowed_root):
    d=Decision(d.path,'skip','outside-allowed-root',d.allowed_root,d.days)
  if apply and d.action=='delete':
   if not secure_delete(d.path,d.allowed_root,cfg):d=Decision(d.path,'skip','unsafe-delete-target',d.allowed_root,d.days)
  print(json.dumps(d.as_dict(),sort_keys=True))

def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--root',default='/data'); ap.add_argument('--apply',action='store_true'); ap.add_argument('--protect-file',default=str(Path(__file__).with_name('protect.txt'))); ap.add_argument('--pr-states-json'); ap.add_argument('--proc-root',default='/proc'); a=ap.parse_args()
 root=Path(a.root).resolve()
 if a.apply and root!=Path('/data'): raise SystemExit('refusing --apply outside exact /data')
 regex=''
 try: regex='|'.join(x.strip() for x in Path(a.protect_file).read_text().splitlines() if x.strip() and not x.startswith('#'))
 except OSError: raise SystemExit('protect file unreadable; fail closed')
 states={}
 if a.pr_states_json: states=json.loads(Path(a.pr_states_json).read_text())
 cfg=Config(root,protect_regex=regex,in_use=proc_targets(Path(a.proc_root)),pr_states=states,proc_root=Path(a.proc_root))
 execute(build_plan(cfg),a.apply,cfg)
if __name__=='__main__':main()
