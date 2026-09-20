'use strict';
const fs = require('fs');
const SITE = 'lunabox.lunafrontdesk.com';
const BEGIN = '# BEGIN luna-routing-contract';
const END = '# END luna-routing-contract';
const PUBLIC = '/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook';
const PROOF = '/whatsapp/routing-proof';
const IMPORT = '/var/lib/luna-routing/luna-number-route.caddy';
function uncomment(line) { return line.replace(/#.*/, ''); }
function locate(text) {
  const lines = String(text).split('\n'); let depth = 0; const sites = []; let active = null;
  for (let i=0;i<lines.length;i++) { const code=uncomment(lines[i]);
    if (depth===0 && new RegExp(`^\\s*${SITE.replaceAll('.','\\.')}\\s*\\{\\s*$`).test(code)) active={start:i,depth:1};
    const opens=(code.match(/{/g)||[]).length, closes=(code.match(/}/g)||[]).length; depth += opens-closes;
    if (active && depth===0) { active.end=i; sites.push(active); active=null; }
  }
  if (active || sites.length!==1) throw Error('expected exactly one unambiguous lunabox site block');
  const site=sites[0], rows=lines.slice(site.start+1,site.end); let local=0; const broad=[];
  for(let i=0;i<rows.length;i++){ const code=uncomment(rows[i]); if(local===0 && /^\s*reverse_proxy\s+\/whatsapp\/\*\s+[^\s{}]+\s*$/.test(code)) broad.push(i); local+=(code.match(/{/g)||[]).length-(code.match(/}/g)||[]).length; }
  if(broad.length!==1) throw Error('expected exactly one broad WhatsApp route in lunabox site');
  return {lines,site,index:site.start+1+broad[0]};
}
function block(indent='') { return [BEGIN,`handle ${PUBLIC} {`,'  rewrite * /v1/routes/meta-whatsapp-verified-webhook','  reverse_proxy 127.0.0.1:8096','}',`handle ${PROOF} {`,'  reverse_proxy 127.0.0.1:8094','}',`import ${IMPORT}`,END].map(x=>indent+x).join('\n'); }
function verify(text) { const found=locate(text); const begins=[...String(text).matchAll(/^\s*# BEGIN luna-routing-contract\s*$/gm)], ends=[...String(text).matchAll(/^\s*# END luna-routing-contract\s*$/gm)]; if(begins.length!==1||ends.length!==1) throw Error('contract markers missing or duplicated'); const indent=/^\s*/.exec(found.lines[found.index])[0]; const rows=block(indent).split('\n'); const actual=found.lines.slice(found.index-rows.length,found.index).join('\n'); if(actual!==block(indent)) throw Error('contract is not canonical or immediately before broad route'); return true; }
function transform(text, update=false) { let source=String(text); const marker=/^\s*# BEGIN luna-routing-contract\s*$[\s\S]*?^\s*# END luna-routing-contract\s*\n?/gm; const matches=[...source.matchAll(marker)]; if(matches.length){ if(matches.length!==1) throw Error('duplicate contract markers'); if(!update){ verify(source); return source; } source=source.replace(marker,''); }
  if(new RegExp(PUBLIC.replaceAll('/','\\/')).test(source)||new RegExp(PROOF.replaceAll('/','\\/')).test(source)||source.includes(IMPORT)||/^\s*# (?:BEGIN|END) luna-routing-contract/m.test(source)) throw Error('partial or misleading routing contract');
  const found=locate(source), indent=/^\s*/.exec(found.lines[found.index])[0]; found.lines.splice(found.index,0,...block(indent).split('\n')); return found.lines.join('\n'); }
if(require.main===module){ const [mode,input,output]=process.argv.slice(2); const text=fs.readFileSync(input,'utf8'); if(mode==='verify') verify(text); else fs.writeFileSync(output,transform(text,mode==='update')); }
module.exports={transform,verify,block};
