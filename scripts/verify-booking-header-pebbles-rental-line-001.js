'use strict';
// Offline display-only regression: real browser helper, no API or payment mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const src = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
const start = src.indexOf('function bcBookingServicesQtyLabel(');
const end = src.indexOf('\nfunction bcRenderFieldEditSectionsHtml', start);
const box = { bcResolveRentalPeopleFromMeta: (m,q) => m.rental_people || q, bcResolveRentalInvoiceDisplayQty: r => r.quantity };
vm.createContext(box);
const rentalStart=src.indexOf('function bcFormatRentalPeopleDaysLine(');
vm.runInContext(src.slice(rentalStart,src.indexOf('\nfunction ',rentalStart+10)),Object.assign(box,{bcPluralUnit:(n,s,p)=>n===1?s:p}));
vm.runInContext(src.slice(start,end),box);
const rows = [
 {service_type:'surfboard',quantity:2,metadata:{rental_people:4,rental_days:2,split_from:'board'},service_date:'2026-09-24'},
 {service_type:'surfboard',quantity:1,metadata:JSON.stringify({rental_people:4,rental_days:1,split_from:'board'}),service_date:'2026-09-25'},
 {service_type:'wetsuit',quantity:2,metadata:{rental_people:4,rental_days:2}},
 {service_type:'yoga',quantity:4,service_date:'2026-10-01'},
];
assert.equal(box.bcBookingServicesQtyLabel(rows),'4× surfboard · 24 Sep – 25 Sep\n4× wetsuit\n4× yoga · 1 Oct');
assert.equal(box.bcBookingServicesQtyLabel([{...rows[0],status:'unscheduled'}]),'4× surfboard');
assert.equal(box.bcBookingServicesQtyLabel([]),'');
assert(!src.slice(src.indexOf('function bcDetailHeaderMetaHtml('),src.indexOf('function bcGuestCountFrom(')).includes('>Link sent<'));
async function main(){
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  // Use all production style blocks, including injected Invoice's computed cascade.
  const html=readStaffPortalUiSource();
  const styles=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(x=>x[0]).join('');
  const invoice=fs.readFileSync(require.resolve('./browser/booking-invoice'),'utf8');
  for(const width of [390,768,1440]){
   await page.setViewportSize({width,height:900});
   await page.setContent(styles+'<div id="bc-drawer-card-booking"><div id="bc-field-group-guests" class="ctx-field-edit-group"><div id="bc-guest-names"><span class="bc-guest-name-row"><span class="bc-guest-name-line">Ada</span><span class="bc-guest-pebble-line"><span class="bc-guest-package-pebble">Uluwatu</span><span class="bc-guest-bed">R3-B1</span><span class="bc-accom-pay-pebble">Unpaid</span></span></span></div></div></div>');
   await page.locator('#bc-drawer-card-booking').evaluate(e=>{e.style.position='static';e.style.width='360px';e.style.maxWidth='100%';});
   await page.evaluate(code=>{window.el=id=>document.getElementById(id);eval(code);bcInvoiceStyles();},invoice);
   const result=await page.locator('.bc-guest-name-row').evaluate(e=>({display:getComputedStyle(e).display,wrapper:getComputedStyle(e.querySelector('.bc-guest-pebble-line')).display,columns:[...e.querySelectorAll('.bc-guest-name-line,.bc-guest-package-pebble,.bc-guest-bed,.bc-accom-pay-pebble')].map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,center:(r.top+r.bottom)/2};}),border:getComputedStyle(document.getElementById('bc-field-group-guests')).borderTopWidth}));
   console.log('Computed guest grid',width,JSON.stringify(result));
   assert.equal(result.display,'grid');assert.equal(result.wrapper,'contents');assert.equal(result.border,'0px');
   assert.equal(result.columns.length,4);
   for(let i=1;i<4;i++){assert(result.columns[i-1].right<=result.columns[i].left+1);assert(Math.abs(result.columns[i].center-result.columns[0].center)<1);}
   console.log('PASS computed guest pebbles / first guest divider',width,JSON.stringify(result));
  }
 }finally{await browser.close();}
 console.log('PASS booking header rental lines, scheduled dates, unscheduled omission, Link sent removal');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
