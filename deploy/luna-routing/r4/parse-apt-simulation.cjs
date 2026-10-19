'use strict';
const ALLOWED = Object.freeze({ action: 'install', package: 'nodejs', version: '22.23.3-1nodesource1', architecture: 'amd64' });
function parseSimulation(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const actions = []; const configured = new Set();
  for (const line of lines) {
    let m;
    if ((m = /^Inst\s+(\S+)(?:\s+\[([^\]]+)\])?\s+\((\S+)\s+[^)]*\[([^\]]+)\]\)$/.exec(line))) {
      if (m[2]) throw new Error(`upgrade/downgrade/reinstall forbidden: ${line}`);
      actions.push({ action: 'install', package: m[1], version: m[3], architecture: m[4] });
    } else if ((m = /^Conf\s+(\S+)\s+\((\S+)\s+[^)]*\[([^\]]+)\]\)$/.exec(line))) {
      configured.add(`${m[1]}\0${m[2]}\0${m[3]}`);
    } else if (/^(?:Remv|Purg|Inst|Conf)\s/.test(line)) throw new Error(`unsupported apt action: ${line}`);
  }
  if (actions.length !== 1 || JSON.stringify(actions[0]) !== JSON.stringify(ALLOWED)) throw new Error('simulation is not the one allowlisted Node install');
  if (configured.size !== 1 || !configured.has(`${ALLOWED.package}\0${ALLOWED.version}\0${ALLOWED.architecture}`)) throw new Error('simulation configuration set is not allowlisted');
  return actions;
}
if (require.main === module) { const fs=require('node:fs'); parseSimulation(fs.readFileSync(process.argv[2], 'utf8')); console.log('PASS exact Node apt simulation'); }
module.exports={parseSimulation,ALLOWED};
