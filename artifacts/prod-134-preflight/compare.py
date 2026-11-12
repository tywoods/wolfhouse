#!/usr/bin/env python3
"""Compare read-only production pricing snapshots; never connects to a database."""
import json
import sys


def check(snapshot):
    assert snapshot['database'] == 'wolfhouse_prod', 'Wrong database'
    assert snapshot['read_only'] == 'on', 'Snapshot was not read-only'
    assert snapshot['standard_items'] == 1, 'Expected one active standard deposit item'
    for key in ('m132_relations_present', 'm133_owned_relation', 'pricing_indexes_valid',
                'pricing_write_privileges', 'pricing_rls_off'):
        assert snapshot[key] is True, f'Precondition failed: {key}'
    assert snapshot['m133_key_constraints'] == 7, '133 key-constraint count changed'
    rates = snapshot['rates']
    assert len(rates) == 2 and {r['item_code'] for r in rates} == {
        'custom_or_short_stay', 'standard_package'}, 'Expected both active global rates'
    assert all(r['unit'] == 'per_person' and r['currency'] == 'EUR'
               and isinstance(r['amount_cents'], int) and r['amount_cents'] >= 0
               for r in rates), 'Unexpected rate shape'
    if snapshot['threshold_present']:
        assert type(snapshot['threshold']) is int and snapshot['threshold'] > 0, 'Invalid existing threshold'


with open(sys.argv[1]) as handle:
    before = json.load(handle)
check(before)
if len(sys.argv) == 2:
    print('BEFORE PASS: pricing/schema compatible; snapshot retained. No migration applied by this check.')
else:
    with open(sys.argv[2]) as handle:
        after = json.load(handle)
    check(after)
    expected = before['threshold'] if before['threshold_present'] else 6
    assert after['threshold_present'] and after['threshold'] == expected, 'Threshold not installed/preserved'
    assert after['rates'] == before['rates'], 'Active deposit amounts/unit/currency changed'
    assert after['rules_hash'] == before['rules_hash'], 'Deposit rules changed (including inactive rows)'
    assert after['items_preserved_hash'] == before['items_preserved_hash'], 'Other item fields/metadata changed'
    print('AFTER PASS: threshold installed/preserved; all deposit rules and other item fields unchanged.')
