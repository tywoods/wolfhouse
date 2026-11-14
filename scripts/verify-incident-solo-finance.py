"""Offline production Staff wrapper/create + real checkout SQL, fake provider only.
Synthetic inventory/prices, not a capture of the incident's hidden accepted_offer.
Run: NODE_PATH=/tmp/sd-0250-pg/node_modules python3 scripts/verify-incident-solo-finance.py
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def run(count, *, projection_failure=False):
    p = subprocess.Popen(['node', 'scripts/fixtures/first-yes-sql.js'], cwd=ROOT,
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    def rpc(**cmd):
        p.stdin.write(json.dumps(cmd) + '\n'); p.stdin.flush()
        result = json.loads(p.stdout.readline())
        assert 'fixture_error' not in result, result
        return result
    try:
        assert json.loads(p.stdout.readline())['ready']
        rpc(serious_booking_setup=True)
        setup = rpc(incident_finance_setup=True)
        names = ['Ale Test Nia 3', 'Offline Second', 'Offline Third'][:count]
        body = dict(confirm=True, check_in='2027-09-20', check_out='2027-09-26',
                    guest_count=count, guest_name=names[0], phone='+' + '999' + '0' * 11 + '1',
                    package_code='malibu', room_type='shared', group_gender='male',
                    selected_bed_codes=['R1-B3', 'R1-B1', 'R1-B2'][:count],
                    payment_choice='deposit', shuttle_choice='declined')
        if count > 1:
            body['guests'] = [{'name': n} for n in names]
        preview = rpc(path='/booking-preview', body=body, guest_phone=body['phone'])
        assert preview['body'].get('success'), preview
        body.update(conversation_id=setup['conversation_id'],
                    accepted_offer=preview['body']['offer_revision'],
                    offer_revision=preview['body']['offer_revision'],
                    offer_fingerprint=preview['body']['offer_revision']['offer_fingerprint'])
        result = rpc(path='/booking-create-from-plan', body=body, raw_body=json.dumps(body),
                     staff_body_stream=True, guest_phone=body['phone'])

        assert result['body'].get('success'), result
        before = rpc(snapshot=True)
        payment_id = before['tables']['payments'][0]['id']
        if projection_failure:
            rpc(reject_guest_projection=True)
            checkout = rpc(path='/offline-checkout', body={'payment_id': payment_id}, guest_phone=body['phone'])
            assert checkout['status'] == 500, checkout
            assert checkout['body']['success'] is False, checkout
            assert checkout['body']['reason_code'] == 'payment_update_failed', checkout
            assert checkout['body']['partial_stripe_session'] is True, checkout
            after = rpc(snapshot=True)
            assert any('offline guest projection rejected' in error for error in after['errors']), after
            for table in ('bookings', 'booking_guests', 'booking_beds'):
                assert after['tables'][table] == before['tables'][table], table
            assert after['tables']['payments'][0]['status'] == 'draft', after
            print('PASS real helper SQL projection failure: typed failure, saved booking/guest/bed rows unchanged')
            return
        if count == 1:
            checkout = rpc(path='/offline-checkout', body={'payment_id': payment_id}, guest_phone=body['phone'])

            assert checkout['body'].get('success'), checkout
        after = rpc(snapshot=True)
        assert len(after['tables']['bookings']) == 1
        assert len(after['tables']['booking_guests']) == count
        payments = after['tables']['payments']
        assert len(payments) == 1, 'Unscoped draft lifecycle is unchanged'
        assert payments[0]['booking_guest_id'] is None
        assert payments[0]['status'] == ('checkout_created' if count == 1 else 'draft')
        assert payments[0]['amount_due_cents'] == 20000 * count
        booking = after['tables']['bookings'][0]
        assert booking['total_amount_cents'] == 29900 * count, booking
        for guest in after['tables']['booking_guests']:
            assert guest['deposit_amount_cents'] == 20000, guest
            assert guest['metadata']['package_code'] == 'malibu', guest
            assert guest['metadata']['subtotal_cents'] == 29900, guest
            assert guest['payment_status'] == ('payment_link_sent' if count == 1 else 'not_requested'), guest
        assert booking['payment_status'] == ('payment_link_sent' if count == 1 else 'not_requested'), booking
        assert after['errors'] == [], after['errors']
        print(f'PASS Staff wrapper/create + explicit checkout SQL: guests={count}; '
              'guest deposit=20000, package=malibu, subtotal=29900; no mapping loss reproduced')
    finally:
        p.stdin.close(); p.wait(timeout=30); p.stdout.close()
        assert p.returncode == 0

if __name__ == '__main__':
    run(1)
    run(3)
    print('PASS synthetic incident-shaped service/SQL controls; NOT owner-turn or missing-money reproduction')
