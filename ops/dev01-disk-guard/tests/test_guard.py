#!/usr/bin/env python3
import importlib.util, json, os, subprocess, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parents[1]
def load(name):
 s=importlib.util.spec_from_file_location(name,HERE/f"{name}.py"); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m

class GuardTests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory(); self.root=Path(self.t.name)/"data"; self.root.mkdir()
 def tearDown(self): self.t.cleanup()
 def old(self,p,days=10):
  p.mkdir(parents=True,exist_ok=True); ts=1_600_000_000; os.utime(p,(ts,ts)); return p
 def test_cleanup_safety_matrix(self):
  c=load('cleanup'); now=1_700_000_000
  eligible=self.old(self.root/'bots/hermes-orchestrator/workspace/scratch-old')
  protected=self.old(self.root/'bots/hermes-orchestrator/workspace/pass4-evidence')
  env=self.old(self.root/'bots/hermes-orchestrator/workspace/.env.bak-x')
  nested_secret=self.old(self.root/'bots/hermes-orchestrator/workspace/scratch-with-secret'); (nested_secret/'.env').write_text('secret')
  os.utime(nested_secret/'.env',(1_600_000_000,1_600_000_000)); os.utime(nested_secret,(1_600_000_000,1_600_000_000))
  recent_child=self.old(self.root/'bots/hermes-orchestrator/workspace/has-new-child'); (recent_child/'x').write_text('x'); os.utime(recent_child/'x',(now,now))
  inuse=self.old(self.root/'bots/hermes-orchestrator/workspace/in-use')
  releases=self.root/'bots/hermes-orchestrator/workspace/releases'
  for i in range(5): self.old(releases/str(i)); os.utime(releases/str(i),(1_600_000_000+i,)*2)
  cfg=c.Config(root=self.root,now=now,protect_regex='pass4|evidence',in_use={'/opt/data/workspace/in-use'},pr_states={})
  plan=c.build_plan(cfg)
  paths={str(x.path.relative_to(self.root)):x for x in plan}
  self.assertEqual(paths['bots/hermes-orchestrator/workspace/scratch-old'].action,'delete')
  self.assertEqual(paths['bots/hermes-orchestrator/workspace/pass4-evidence'].action,'skip')
  self.assertEqual(paths['bots/hermes-orchestrator/workspace/.env.bak-x'].action,'skip')
  self.assertEqual(paths['bots/hermes-orchestrator/workspace/scratch-with-secret'].action,'skip')
  self.assertEqual(paths['bots/hermes-orchestrator/workspace/scratch-with-secret'].reason,'protected-descendant')
  self.assertEqual(paths['bots/hermes-orchestrator/workspace/has-new-child'].action,'skip')
  self.assertEqual(paths['bots/hermes-orchestrator/workspace/in-use'].action,'skip')
  self.assertEqual(sum(v.action=='delete' for k,v in paths.items() if '/releases/' in k),2)
  c.execute(plan,apply=False); self.assertTrue(eligible.exists())
  c.execute(plan,apply=True,cfg=cfg); self.assertFalse(eligible.exists())
 def test_host_in_use_and_container_mapping(self):
  c=load('cleanup'); root=self.root
  cand=root/'bots/hermes-captain/artifacts/review-pr1-x'; self.old(cand)
  self.assertTrue(c.is_in_use(cand,root,{'/data/bots/hermes-captain/artifacts/review-pr1-x/file'}))
  self.assertTrue(c.is_in_use(cand,root,{'/opt/data/artifacts/review-pr1-x/file'}))
 def test_review_pr_closed_only(self):
  c=load('cleanup'); now=1_700_000_000; p=self.old(self.root/'bots/hermes-captain/artifacts/review-pr1365-x')
  for state,action in [('OPEN','skip'),('UNKNOWN','skip'),('CLOSED','delete'),('MERGED','delete')]:
   got=c.build_plan(c.Config(self.root,now,'nomatch',set(),{'1365':state}))
   self.assertEqual(next(x for x in got if x.path==p).action,action)
 def test_git_fail_closed_conditions_and_nested_git(self):
  c=load('cleanup'); p=self.old(self.root/'bots/hermes-orchestrator/workspace/clone')
  subprocess.run(['git','init','-q',p],check=True); subprocess.run(['git','-C',p,'config','user.email','t@x'],check=True); subprocess.run(['git','-C',p,'config','user.name','t'],check=True)
  (p/'a').write_text('a'); subprocess.run(['git','-C',p,'add','.'],check=True); subprocess.run(['git','-C',p,'commit','-qm','x'],check=True)
  ok,reason=c.git_safe(p); self.assertFalse(ok); self.assertIn('upstream',reason)
  (p/'dirty').write_text('x'); ok,reason=c.git_safe(p); self.assertFalse(ok); self.assertIn('dirty',reason)
  broken=self.old(self.root/'bots/hermes-orchestrator/workspace/worktree-broken'); (broken/'.git').write_text('gitdir: /gone/nope\n')
  ok,reason=c.git_safe(broken); self.assertFalse(ok)
  nested=self.old(self.root/'bots/hermes-captain/artifacts/DEPOSIT-FROM-ADMIN-PRICING-001'); (nested/'.git').mkdir()
  self.assertFalse(c.git_safe(nested)[0])
 def test_cleanup_refuses_symlinked_parent_escape(self):
  c=load('cleanup'); outside=Path(self.t.name)/'outside'; victim=self.old(outside/'victim')
  allowed=self.root/'bots/hermes-orchestrator/workspace'; allowed.mkdir(parents=True)
  (allowed/'escape').symlink_to(outside,target_is_directory=True)
  plan=[c.Decision(allowed/'escape/victim','delete','non-git',allowed_root=self.root)]
  c.execute(plan,apply=True)
  self.assertTrue(victim.exists())
 def test_cleanup_refuses_parent_symlink_swap_after_validation(self):
  c=load('cleanup'); now=1_700_000_000
  workspace=self.root/'bots/hermes-orchestrator/workspace'; candidate=self.old(workspace/'swap-target')
  outside=Path(self.t.name)/'outside'; outside_target=self.old(outside/'swap-target')
  cfg=c.Config(self.root,now,'nomatch',set(),{})
  plan=c.build_plan(cfg); original=c.within_allowed_root; calls=0
  def swap_after_validation(path,root):
   nonlocal calls
   result=original(path,root); calls+=1
   if calls==2:
    workspace.rename(workspace.with_name('workspace-original'))
    workspace.symlink_to(outside,target_is_directory=True)
   return result
  with patch.object(c,'within_allowed_root',side_effect=swap_after_validation):
   c.execute(plan,apply=True,cfg=cfg)
  self.assertTrue(outside_target.exists())
 def test_cleanup_revalidates_target_before_delete(self):
  c=load('cleanup'); now=1_700_000_000
  candidate=self.old(self.root/'bots/hermes-orchestrator/workspace/stale-plan')
  cfg=c.Config(self.root,now,'nomatch',set(),{})
  plan=c.build_plan(cfg)
  self.assertEqual(next(x for x in plan if x.path==candidate).action,'delete')
  secret=candidate/'.env'; secret.write_text('added after planning'); os.utime(secret,(1_600_000_000,1_600_000_000)); os.utime(candidate,(1_600_000_000,1_600_000_000))
  c.execute(plan,apply=True,cfg=cfg)
  self.assertTrue(candidate.exists())
 def test_cleanup_refreshes_in_use_targets_before_delete(self):
  c=load('cleanup'); now=1_700_000_000; proc=Path(self.t.name)/'proc'
  candidate=self.old(self.root/'bots/hermes-orchestrator/workspace/newly-in-use'); active=candidate/'active'; active.write_text('x'); os.utime(active,(1_600_000_000,1_600_000_000)); os.utime(candidate,(1_600_000_000,1_600_000_000))
  cfg=c.Config(self.root,now,'nomatch',set(),{},proc_root=proc)
  plan=c.build_plan(cfg); fd=proc/'123/fd'; fd.mkdir(parents=True); (fd/'1').symlink_to(active)
  c.execute(plan,apply=True,cfg=cfg)
  self.assertTrue(candidate.exists())
 def test_cleanup_refuses_target_swapped_to_folder_with_env_at_removal(self):
  c=load('cleanup'); now=1_700_000_000
  candidate=self.old(self.root/'bots/hermes-orchestrator/workspace/swapped-env')
  cfg=c.Config(self.root,now,'nomatch',set(),{})
  plan=c.build_plan(cfg); original=c.secure_delete
  def swap_then_delete(path,root,*args):
   candidate.rename(candidate.with_name('swapped-env-original'))
   replacement=self.old(candidate); secret=replacement/'.env'; secret.write_text('secret')
   os.utime(secret,(1_600_000_000,1_600_000_000)); os.utime(replacement,(1_600_000_000,1_600_000_000))
   return original(path,root,*args)
  with patch.object(c,'secure_delete',side_effect=swap_then_delete):
   c.execute(plan,apply=True,cfg=cfg)
  self.assertTrue(candidate.exists())
  self.assertTrue((candidate/'.env').exists())
 def test_cleanup_refuses_target_that_becomes_in_use_at_removal(self):
  c=load('cleanup'); now=1_700_000_000; proc=Path(self.t.name)/'proc'
  candidate=self.old(self.root/'bots/hermes-orchestrator/workspace/swapped-in-use')
  cfg=c.Config(self.root,now,'nomatch',set(),{},proc_root=proc)
  plan=c.build_plan(cfg); original=c.secure_delete
  def swap_then_delete(path,root,*args):
   candidate.rename(candidate.with_name('swapped-in-use-original'))
   replacement=self.old(candidate); active=replacement/'active'; active.write_text('x')
   os.utime(active,(1_600_000_000,1_600_000_000)); os.utime(replacement,(1_600_000_000,1_600_000_000))
   fd=proc/'123/fd'; fd.mkdir(parents=True); (fd/'1').symlink_to(active)
   return original(path,root,*args)
  with patch.object(c,'secure_delete',side_effect=swap_then_delete):
   c.execute(plan,apply=True,cfg=cfg)
  self.assertTrue(candidate.exists())
  self.assertTrue((candidate/'active').exists())
 def test_cleanup_preserves_claim_when_env_appears_after_claim_checks(self):
  c=load('cleanup'); now=1_700_000_000
  candidate=self.old(self.root/'bots/hermes-orchestrator/workspace/late-env')
  cfg=c.Config(self.root,now,'nomatch',set(),{})
  plan=c.build_plan(cfg); original=c.is_in_use; calls=0
  def add_env_after_checks(path,root,targets):
   nonlocal calls
   result=original(path,root,targets); calls+=1
   if calls==2:
    claimed=next(candidate.parent.glob('.dev01-delete-*'))
    secret=claimed/'.env'; secret.write_text('late secret'); os.utime(secret,(1_600_000_000,1_600_000_000))
   return result
  with patch.object(c,'is_in_use',side_effect=add_env_after_checks):
   c.execute(plan,apply=True,cfg=cfg)
  self.assertTrue(candidate.exists()); self.assertTrue((candidate/'.env').exists())
 def test_cleanup_preserves_claim_when_it_becomes_in_use_after_claim_checks(self):
  c=load('cleanup'); now=1_700_000_000; proc=Path(self.t.name)/'proc'
  candidate=self.old(self.root/'bots/hermes-orchestrator/workspace/late-in-use')
  active=candidate/'active'; active.write_text('x'); os.utime(active,(1_600_000_000,1_600_000_000)); os.utime(candidate,(1_600_000_000,1_600_000_000))
  cfg=c.Config(self.root,now,'nomatch',set(),{},proc_root=proc)
  plan=c.build_plan(cfg); original=c.is_in_use; calls=0
  def mark_in_use_after_checks(path,root,targets):
   nonlocal calls
   result=original(path,root,targets); calls+=1
   if calls==2:
    claimed=next(candidate.parent.glob('.dev01-delete-*'))
    fd=proc/'123/fd'; fd.mkdir(parents=True); (fd/'1').symlink_to(candidate/'active')
   return result
  with patch.object(c,'is_in_use',side_effect=mark_in_use_after_checks):
   c.execute(plan,apply=True,cfg=cfg)
  self.assertTrue(candidate.exists()); self.assertTrue((candidate/'active').exists())
 def test_cleanup_preserves_claim_when_parent_moves_after_claim_checks(self):
  c=load('cleanup'); now=1_700_000_000
  workspace=self.root/'bots/hermes-orchestrator/workspace'; candidate=self.old(workspace/'late-move')
  moved=Path(self.t.name)/'moved-workspace'; cfg=c.Config(self.root,now,'nomatch',set(),{})
  plan=c.build_plan(cfg); original=c.is_in_use; calls=0
  def move_parent_after_checks(path,root,targets):
   nonlocal calls
   result=original(path,root,targets); calls+=1
   if calls==2: workspace.rename(moved)
   return result
  with patch.object(c,'is_in_use',side_effect=move_parent_after_checks):
   c.execute(plan,apply=True,cfg=cfg)
  self.assertTrue((moved/'late-move').exists())
 def test_config_generators(self):
  d=load('daemon_config'); src={'features':{'containerd-snapshotter':True},'log-opts':{'labels':'x'}}
  out=d.merge_config(src); self.assertTrue(out['features']['containerd-snapshotter']); self.assertEqual(out['log-driver'],'json-file'); self.assertEqual(out['log-opts']['max-size'],'20m'); self.assertEqual(out['log-opts']['max-file'],'3'); self.assertEqual(out['log-opts']['labels'],'x')
  b=(HERE/'build-cache-prune.sh').read_text(); self.assertIn('docker buildx prune --builder zeroazure-builder --keep-storage 2gb -f',b); self.assertIn('docker buildx prune --builder default --keep-storage 2gb -f',b); self.assertNotRegex(b,r'docker (system|image|volume) prune')
 def test_alert_thresholds_dedup_and_token_reference(self):
  a=load('disk_alert'); self.assertEqual(a.level(84,20),'ok'); self.assertEqual(a.level(85,20),'yellow'); self.assertEqual(a.level(90,20),'red'); self.assertEqual(a.level(70,14.9),'red')
  state=Path(self.t.name)/'state'; sent=[]
  a.maybe_send('yellow','msg',state,lambda m:sent.append(m)); a.maybe_send('yellow','msg2',state,lambda m:sent.append(m)); a.maybe_send('red','msg3',state,lambda m:sent.append(m)); self.assertEqual(sent,['msg','msg3'])
  text=(HERE/'disk_alert.py').read_text(); self.assertNotIn('Bot ',text); self.assertIn('DISCORD_BOT_TOKEN_FILE',text); self.assertIn('1537017482748100678',text)
 def test_print_only_does_not_acknowledge_alert_severity(self):
  a=load('disk_alert'); state=Path(self.t.name)/'print-only-state'; printed=[]; sent=[]
  a.maybe_send('yellow','preview',state,printed.append,record_state=False)
  self.assertFalse(state.exists())
  a.maybe_send('yellow','live',state,sent.append)
  self.assertEqual(printed,['preview']); self.assertEqual(sent,['live'])

if __name__=='__main__': unittest.main(verbosity=2)
