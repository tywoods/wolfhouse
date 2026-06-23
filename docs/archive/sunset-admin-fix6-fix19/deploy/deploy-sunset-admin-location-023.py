#!/usr/bin/env python3
"""Apply 023, seed sardinero, deploy admin config branch, enable writes."""
import json
import subprocess
import time
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
SHA = '72ab639'
TAG = f'{SHA}-sunset-school-admin-config'
RG = 'luna-sunset-staging-rg'
APP = 'luna-sunset-staging-staff-api'
MIG = ROOT / 'database/migrations/023_sunset_admin_location_id_PROPOSED.sql'


def run(cmd, **kw):
    print('>>', ' '.join(cmd) if isinstance(cmd, list) else cmd)
    return subprocess.run(cmd, cwd=ROOT, check=True, text=True, capture_output=True, **kw)


def run_out(cmd):
    r = run(cmd)
    return (r.stdout or '').strip()


def db_exec_node(script_path, *args):
    r = run(['node', str(script_path), *args])
    return r.stdout


def preflight():
    out = db_exec_node('/opt/wolfhouse/WH/_work/sunset-admin-023-orchestrate.js', 'preflight')
    print(out)
    data = json.loads(out.split('\n')[-1] if '\n{' in out else out)
    if data['database'] != 'sunset_staging':
        raise SystemExit('wrong db')
    if data['location_id_columns'].get('tenant_price_rules'):
        print('SKIP migration: location_id already present')
        return False
    return True


def apply_migration():
    sql = MIG.read_text()
    runner = ROOT / '_work/run-sql-via-pg.js'
    runner.write_text(
        "const fs=require('fs');\n"
        "const {withPgClient}=require('./scripts/lib/pg-connect');\n"
        "const sql=fs.readFileSync(process.argv[2],'utf8');\n"
        "withPgClient(async c=>{\n"
        "  const db=(await c.query('SELECT current_database() db')).rows[0].db;\n"
        "  if(db!=='sunset_staging') throw new Error('wrong db '+db);\n"
        "  await c.query(sql);\n"
        "  console.log(JSON.stringify({ok:true,applied:'023',database:db}));\n"
        "}).catch(e=>{console.error(e.message);process.exit(1);});\n"
    )
    out = db_exec_node(runner, str(MIG))
    print(out)


def seed_sardinero():
    env = {**dict(subprocess.os.environ), 'ALLOW_SUNSET_ADMIN_LOCATION_BACKFILL': '1'}
    r = subprocess.run(
        ['node', 'scripts/backfill-sunset-admin-location-config.js'],
        cwd=ROOT, env=env, text=True, capture_output=True, check=True,
    )
    print(r.stdout)


def post_migration_check():
    out = db_exec_node('/opt/wolfhouse/WH/_work/sunset-admin-023-orchestrate.js', 'post')
    print(out)


def deploy():
    run([
        'az', 'acr', 'build', '--registry', 'whstagingacr',
        '--file', 'Dockerfile.luna-sunset-staff-api',
        '--image', f'luna-sunset-staff-api:{TAG}',
        '.',
    ])
    run([
        'az', 'containerapp', 'update',
        '-g', RG, '-n', APP,
        '--image', f'whstagingacr.azurecr.io/luna-sunset-staff-api:{TAG}',
        '--set-env-vars',
        'STAFF_ACTIONS_ENABLED=true',
        'STRIPE_LINKS_ENABLED=true',
        'SUNSET_ADMIN_DB_READ_ENABLED=true',
        'SUNSET_ADMIN_WRITES_ENABLED=true',
        'SUNSET_ADMIN_JSON_OVERLAY=false',
        'STRIPE_CHECKOUT_SUCCESS_URL=https://sunset-staging.lunafrontdesk.com/staff/login?checkout=success&session_id={CHECKOUT_SESSION_ID}',
        'STRIPE_CHECKOUT_CANCEL_URL=https://sunset-staging.lunafrontdesk.com/staff/login?checkout=cancel',
    ])
    prev_rev = None
    for i in range(36):
        revs = json.loads(run_out([
            'az', 'containerapp', 'revision', 'list', '-g', RG, '-n', APP, '-o', 'json',
        ]))
        revs.sort(key=lambda r: r['properties'].get('createdTime', ''), reverse=True)
        top = revs[0]
        p = top['properties']
        img = p['template']['containers'][0]['image']
        health = p.get('healthState')
        traffic = p.get('trafficWeight', 0)
        print(f'poll {i}: {top["name"]} health={health} traffic={traffic} img={img}')
        if i == 0 and len(revs) > 1:
            prev_rev = revs[1]['name']
        if TAG in img and health == 'Healthy' and traffic == 100:
            print(json.dumps({
                'revision': top['name'],
                'image': img,
                'previous_revision': prev_rev,
                'commit': SHA,
            }))
            return top['name'], img, prev_rev
        time.sleep(10)
    raise SystemExit('deploy timeout')


def main():
    subprocess.run(['git', 'checkout', 'feature/sunset-school-admin-config'], cwd=ROOT, check=True)
    subprocess.run(['git', 'pull', 'origin', 'feature/sunset-school-admin-config'], cwd=ROOT, check=True)
    sha = run_out(['git', 'rev-parse', 'HEAD'])
    print('commit', sha)
    if not sha.startswith(SHA):
        raise SystemExit(f'unexpected commit {sha}')

    need_mig = preflight()
    if need_mig:
        apply_migration()
    post_migration_check()
    seed_sardinero()
    post_migration_check()
    deploy()


if __name__ == '__main__':
    main()
