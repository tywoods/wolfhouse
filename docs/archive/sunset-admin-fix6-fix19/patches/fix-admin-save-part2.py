#!/usr/bin/env python3
from pathlib import Path
api_path = Path('/opt/wolfhouse/WH/scripts/staff-query-api.js')
api = api_path.read_text(encoding='utf-8')

old_gate = """      if (!adminCfgWritesEnabled(cfg)) return;
    }
    if (action === 'toggle-pill'){"""

new_gate = """      if (!adminCfgWritesEnabled(cfg)){ adminShowMessage('error', portalT('admin.banner.writesDisabled')); return; }
    }
    if (action === 'toggle-pill'){"""

if old_gate in api:
    api = api.replace(old_gate, new_gate, 1)
    print('OK writes gate message')
else:
    print('SKIP writes gate message')

PACK = '''
    if (action === 'add-pack'){
      adminEditTarget = 'pack:new';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'edit-pack'){
      adminEditTarget = 'pack:' + String(btn.getAttribute('data-pack-id') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'delete-pack'){
      var deletePackId = String(btn.getAttribute('data-pack-id') || '');
      if (!deletePackId || !window.confirm(portalT('admin.edit.confirmRemovePack'))) return;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/surf-packs/' + encodeURIComponent(deletePackId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPack'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
    if (action === 'save-pack' || action === 'save-new-pack'){
      var packId = action === 'save-pack' ? String(btn.getAttribute('data-pack-id') || '') : '';
      var payload = adminReadPackFormPayload(packId || null);
      if (!payload.label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      var packReq = packId
        ? adminApiRequest('PATCH', '/staff/admin/config/surf-packs/' + encodeURIComponent(packId) + adminClientQuery(), payload)
        : adminApiRequest('POST', '/staff/admin/config/surf-packs' + adminClientQuery(), payload);
      packReq.then(function(res){
        adminSaveBusy = false;
        if ((res.status !== 200 && res.status !== 201) || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
          return;
        }
        adminShowMessage('success', packId ? portalT('admin.edit.savedPack') : portalT('admin.edit.addedPack'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }
'''

if "adminEditTarget = 'pack:new'" not in api:
    api = api.replace("    if (action === 'save-new-time'){", PACK + "\n    if (action === 'save-new-time'){", 1)
    print('OK pack handlers')
else:
    print('SKIP pack handlers')

api_path.write_text(api, encoding='utf-8')
print('DONE')
