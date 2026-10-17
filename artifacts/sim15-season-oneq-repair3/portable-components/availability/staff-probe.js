'use strict';
// Offline only. Synthetic inventory; production command/service/HTTP mapper.
const root = process.env.REVIEW_WORKTREE;
const fs = require('fs');
require('node:net').Socket.prototype.connect = () => { throw new Error('network forbidden'); };
const assert = require('node:assert/strict');
const service = require(root + '/scripts/lib/luna-front-desk-accommodation-availability-service');
const { computeWolfhouseRoomOptionFlags: flags } = require(root + '/scripts/lib/wolfhouse-room-options');
const { runAvailabilityBedSelection: pick } = require(root + '/scripts/lib/luna-bed-allocator');
const bed = (room, type, n=1, mode='shared') => ({bed_code:`${room}-B${n}`, room_code:room, room_type:type, selling_mode:mode, capacity:3, bed_active:true, bed_sellable:true});
async function main() {
  if (process.argv[2] === 'bridge') {
    const {payload, rows, blocks=[]} = JSON.parse(fs.readFileSync(0,'utf8'));
    const built = service.buildWolfhouseAvailabilityCommand({channel:'bot_http', transportBody:payload, demoCalendarEnrichment:false, quoteConfig:require(root + '/scripts/lib/wolfhouse-quote-calculator').loadConfig()});
    assert.equal(built.ok,true);
    let calls=0;
    const pg = {query:async () => {calls++; assert(calls<=2, 'unexpected DB access'); return {rows:calls===1?rows:blocks};}};
    const checked = await service.executeWolfhouseAvailabilityCheck(pg,built.command);
    assert.equal(checked.ok,true, JSON.stringify(checked));
    assert.equal(calls,2,'expected inventory and occupancy queries');
    process.stdout.write(JSON.stringify(service.mapBotHttpAvailabilityResponse(checked.body)));
    return;
  }
  const scenarios = [
    ['female metadata outside R5/R8', [bed('X','female_only')],1,true,false],
    ['R5 male metadata', [bed('R5','male_only')],1,false,false],
    ['R8 mixed metadata', [bed('R8','mixed')],1,false,false],
    ['private female room not shared', [bed('X','female_only',1,'private')],1,false,true],
    ['empty optional female room', [bed('X','female_only',1,'private_optional'),bed('X','female_only',2,'private_optional')],1,true,true],
    ['female capacity cannot combine rooms', [bed('X','female_only'),bed('Y','female_only')],2,false,false],
  ];
  for (const [name, rows, count, girls, priv] of scenarios) {
    const result=flags(rows,count,rows,[]);
    assert.equal(result.girls_room_available,girls,name);
    assert.equal(result.private_room_available,priv,name);
    console.log('PASS',name,JSON.stringify(result));
  }
  const rows=[bed('X','female_only',1,'private_optional'),bed('X','female_only',2,'private_optional')];
  const blocks=[{bed_code:'X-B2',room_code:'X'}];
  const busy=flags([rows[0]],1,rows,blocks);
  assert.equal(busy.girls_room_available,true); assert.equal(busy.private_room_available,false);
  console.log('PASS occupied optional sibling prevents private',JSON.stringify(busy));
  const r6=[bed('R6','female_only')];
  const mismatch={flags:flags(r6,2,r6,[]), allocation:pick({bedRows:r6,blockRows:[],guestCount:2,roomPreference:'female_only',groupGender:'female',capacityOnly:false})};
  console.log('OBSERVED R6 canonical female single bed / two occupants',JSON.stringify(mismatch));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
