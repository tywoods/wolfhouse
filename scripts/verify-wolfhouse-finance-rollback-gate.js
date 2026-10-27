'use strict';
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ui = fs.readFileSync(path.join(__dirname, 'browser/sunset-admin-ui.js'), 'utf8');
let pass=0, fail=0; function ok(n,v){if(v) pass++; else fail++; console.log(`  ${v?'PASS':'FAIL'}  ${n}`);}
function fn(name){ const start=ui.indexOf('function '+name+'('); if(start<0) throw Error(name); let i=ui.indexOf('{',start), d=0; for(;i<ui.length;i++){if(ui[i]==='{')d++;else if(ui[i]==='}'&&!--d)return ui.slice(start,i+1);} }
const ctx={portalLang:'en', portalT:k=>({ 'admin.finance.booked':'Booked sales','admin.finance.collectedGross':'Net collected','admin.finance.outstanding':'Balance still due','admin.finance.bookings':'Bookings','admin.finance.grossNote':'','admin.finance.today':'Today','admin.finance.week':'Week','admin.finance.month':'Month'}[k]||k),escHtml:s=>String(s),financeFmtEur:n=>'€'+(n/100).toFixed(2),financePeriodEmpty:()=>false,financeMetricRow:(l,v)=>l+':'+v,financeCard:k=>'Booked sales Net collected Balance still due',renderFinanceTrendHtml:()=>'',renderFinanceRedesignHtml:()=> 'Creator comparison'};
vm.createContext(ctx); ['renderWolfhouseCreatorCountRow','renderFinanceSummaryHtml'].forEach(n=>vm.runInContext(fn(n),ctx));
const metric=(count,cents)=>({state:'complete',count,amount_cents:cents});
const row=(creator,count,cents)=>({creator,new_booking_count:{state:'complete',count},new_booking_value:{state:'complete',amount_cents:cents}});
const projection={schema_version:'wolfhouse.creator-finance.v1',creators:[row('luna',1,10000),row('staff',1,20000),row('other_imported',0,0),row('unattributed',0,0),row('total',2,30000)]};
const summary={redesign:{},periods:{today:{},week:{},month:{}}};
const html=ctx.renderFinanceSummaryHtml(summary,projection,true);
ok('Wolfhouse redesign summary uses original headings',/Net collected/.test(html)&&/Booked sales/.test(html)&&/Balance still due/.test(html));
ok('creator counts reconcile Luna + Staff = Total',/Luna.*1.*€100\.00[\s\S]*Staff.*1.*€200\.00[\s\S]*Total.*2.*€300\.00/.test(html));
ok('Wolfhouse never renders Creator comparison',!html.includes('Creator comparison'));
const missing=ctx.renderFinanceSummaryHtml(summary,null,true); ok('missing projection still original layout',/Net collected/.test(missing)&&!missing.includes('Creator comparison'));
// Source-level route gates cover initial render plus locale and trend repaint paths.
ok('initial, locale and trend routes all guard Wolfhouse redesign', (ui.match(/getClient\(\) !== 'wolfhouse-somo'/g)||[]).length>=2 && /!isWolfhouse/.test(ui));
console.log(`\n── finance rollback gate: ${pass} passed, ${fail} failed ──`); if(fail)process.exitCode=1;
