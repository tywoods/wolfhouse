"""Offline, bounded-English proposition parser and owner-fact comparator.

This is not a natural-language entailment model. Every clause must have a complete
parse; unknown prose is exposed in ``unparsed`` and fails closed. Parsing and
comparison are separate: owner values never decide whether a clause is recognized.
The owner only supplies entity spellings (catalog aliases) and the default currency.
Receipt authentication remains the caller's responsibility.

Public interface: reply_truth(reply, outcome, facts, result, catalog_terms=()).
Diagnostic interface: parse_reply(...) and diagnose_reply(...). Spans are half-open
character offsets into the ORIGINAL reply, including punctuation-preserving splits.
"""
import re
from decimal import Decimal
from typing import NamedTuple


class Proposition(NamedTuple):
    subject: object
    predicate: str
    object: object
    polarity: bool
    span: tuple
    modality: str = 'asserted'


class Parse(NamedTuple):
    propositions: tuple
    consumed: tuple
    unparsed: tuple


class ActivityReference(NamedTuple):
    code: str


DATE = r'\d{4}-\d{2}-\d{2}'
NUMBER = r'[+-]?\d+(?:[.,]\d+)*'
COUNTS = {word: i for i, word in enumerate(('zero', 'one', 'two', 'three', 'four', 'five',
                                          'six', 'seven', 'eight', 'nine', 'ten'))}
COUNT = r'(?:\d+|' + '|'.join(COUNTS) + r')'
ROLE = r'(?:remaining balance|remaining|remainder|balance|total|deposit)'
CURRENCIES = {'€': 'EUR', '$': 'USD', '£': 'GBP', 'euro': 'EUR', 'euros': 'EUR',
              'us dollar': 'USD', 'us dollars': 'USD', 'dollar': 'USD', 'dollars': 'USD',
              'british pound': 'GBP', 'british pounds': 'GBP', 'pounds': 'GBP'}
CURRENCY = '(?:' + '|'.join(re.escape(v) for v in sorted(CURRENCIES, key=len, reverse=True)) + r'|[a-z]{3})'
MONEY = rf'(?:(?P<currency1>{CURRENCY})\s*(?P<amount1>{NUMBER})|(?P<amount2>{NUMBER})\s*(?P<currency2>{CURRENCY})|(?P<bare>{NUMBER}))'
DETERMINER = r'(?:(?:the|your|this|that|a|an)\s+)?'
# Operators belong to a parsed predicate, not a window around an arbitrary token.
COPULA = r'(?:(?:is|are|was|were|equals?)\s+)?(?:definitely\s+)?(?P<neg>not\s+(?:equal\s+to\s+)?|never\s+)?(?:of\s+)?'
NAME = r"[a-z][\w'-]*(?:\s+[a-z][\w'-]*)?"
PEOPLE = rf'{NAME}(?:(?:\s*(?:,|&)\s*|\s+and\s+){NAME})*'
DATES = rf'{DATE}(?:(?:\s*,\s*|\s+and\s+){DATE})*'
RANGE = rf'(?P<arrival>{DATE})\s*(?:to|through|until|–|—| - )\s*(?P<departure>{DATE})'


def _full(pattern, text):
    return re.fullmatch(pattern, text, re.I)


def _currency(value):
    return CURRENCIES.get(value.lower(), value.upper())


def _count(value):
    return COUNTS[value] if value in COUNTS else int(value)


def _people(value):
    return tuple(sorted(v.strip() for v in re.split(r',|&|\band\b', value) if v.strip()))


def _role(value):
    return {'balance': 'remaining', 'remainder': 'remaining', 'remaining balance': 'remaining'}.get(value, value)


def _cents(value):
    if _full(r'[+-]?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?', value):
        value = value.replace(',', '')
    elif _full(r'[+-]?\d+(?:[.,]\d{1,2})?', value):
        value = value.replace(',', '.')
    else:
        raise ValueError('money lexeme must be consumed in full with at most two decimals')
    return int(Decimal(value) * 100)


def _term(value):
    return re.sub(r'^(?:the|a|your)\s+', '', value.strip().lower())


class Parser:
    """Complete-clause grammar with coordinated predicates and local discourse state."""
    def __init__(self, text, facts, catalog_terms):
        self.text = text
        self.facts = facts or {}
        self.claims, self.consumed, self.unparsed = [], [], []
        self.last_addon = None
        self.last_people = ()
        self.aliases = {}
        self.addon_codes = {a['code'].lower() for a in self.facts.get('add_ons', [])}
        package = self.facts.get('package', {})
        codes = [p['code'] for p in package.get('per_guest', [])]
        if package.get('code'):
            codes.append(package['code'])
        codes.extend(a['code'] for a in self.facts.get('add_ons', []))
        for code in codes:
            self.aliases[code.lower()] = code.lower()
        for row in catalog_terms:
            if isinstance(row, dict) and isinstance(row.get('code'), str):
                code = row['code'].lower()
                self.aliases[code] = code
                for term in row.get('terms', []):
                    if isinstance(term, str) and term:
                        self.aliases[term.lower()] = code
        terminals = [re.escape(a) for a in sorted(self.aliases, key=len, reverse=True)]
        terminals.append(r'(?!the\b|your\b|this\b|that\b)[\w-]+')
        self.product = '(?:' + '|'.join(terminals) + ')'

    def emit(self, subject, predicate, value, positive, span, modality='asserted'):
        self.claims.append(Proposition(subject, predicate, value, positive, span, modality))

    def code(self, value):
        return self.aliases.get(value, value)

    def parse(self):
        # Dots inside numeric lexemes are NOT sentence boundaries. A malformed
        # amount such as 12.34.56 must survive lexing so it cannot be truncated.
        start = 0
        for end in re.finditer(r'[;!?\n]+|(?<!\d)\.|\.(?!\d)', self.text):
            self.clause(start, end.start())
            self.consumed.append((end.start(), end.end(), 'punctuation'))
            self.last_people = ()  # subject ellipsis is clause-local
            start = end.end()
        self.clause(start, len(self.text))
        return Parse(tuple(self.claims), tuple(self.consumed), tuple(self.unparsed))

    def clause(self, start, end):
        raw = self.text[start:end]
        start += len(raw) - len(raw.lstrip())
        end -= len(raw) - len(raw.rstrip())
        if start >= end:
            return
        text = self.text[start:end].lower().replace('’', "'")
        span = (start, end)
        # Try complete productions before splitting coordinated names/date lists.
        if self.atom(text, span):
            self.consumed.append((start, end, 'clause'))
            return
        # Scoped quote headings are composition rules, not token deletion.
        m = re.match(rf'(?:for\s+)?{RANGE}\s*[:,]\s*', text)
        if m:
            self.stay(m, (start, start + m.end()))
            self.consumed.append((start, start + m.end(), 'stay-heading'))
            self.clause(start + m.end(), end)
            return
        m = re.match(rf'(?:for\s+)?(?:the\s+)?(?P<product>{self.product})\s+package\s+(?:from\s+|\(){RANGE}\)?\s*[:,]\s*', text)
        if m:
            self.stay(m, (start, start + m.end()))
            self.emit((), 'package', self.code(m['product']), True, (start, start + m.end()))
            self.consumed.append((start, start + m.end(), 'product-stay-heading'))
            self.clause(start + m.end(), end)
            return
        m = re.match(rf'(?:the\s+)?(?P<product>{self.product})\s+package\s+has\s+(?=(?:a\s+)?{ROLE}\b)', text)
        if m:
            self.emit((), 'package', self.code(m['product']), True, (start, start + m.end()))
            self.consumed.append((start, start + m.end(), 'product-price-subject'))
            self.clause(start + m.end(), end)
            return
        # Split only at linguistic boundaries, never at thousands/decimal commas.
        for sep in re.finditer(r'\s+\b(?:but|however|whereas|and)\b\s+|,(?!\d)\s*', text):
            left, right = text[:sep.start()], text[sep.end():]
            if not left.strip() or not right.strip():
                continue
            # A fronted person and coordinated date/participant lists are parsed
            # by the complete add-on production, not by this fallback.
            self.clause(start, start + sep.start())
            self.consumed.append((start + sep.start(), start + sep.end(), 'coordination'))
            if right.startswith('and '):
                self.consumed.append((start + sep.end(), start + sep.end() + 4, 'coordination'))
                self.clause(start + sep.end() + 4, end)
            else:
                self.clause(start + sep.end(), end)
            return
        self.unparsed.append((start, end, self.text[start:end]))

    def stay(self, match, span):
        self.emit('stay', 'check_in', match['arrival'], True, span)
        self.emit('stay', 'check_out', match['departure'], True, span)

    def atom(self, text, span):
        if self.speech(text, span) or self.transaction(text, span):
            return True
        m = _full(rf'(?:for\s+)?{RANGE}', text)
        if m:
            self.stay(m, span)
            return True
        m = _full(rf'(?:your\s+|you\s+)?(?P<role>check[ -]?in|arriv(?:e|al|ing)|check[ -]?out|depart(?:ure|ing)?|leav(?:e|ing))(?:\s+date)?\s*:?\s*{COPULA}(?:on\s+)?(?:the\s+)?(?P<date>{DATE})', text)
        if m:
            role = 'check_in' if re.match(r'check[ -]?in|arriv', m['role']) else 'check_out'
            self.emit('stay', role, m['date'], not m['neg'], span)
            return True
        m = _full(rf'(?:all\s+)?(?:the\s+)?(?:amounts?|prices?|currency)\s+(?:is|are)\s+(?P<neg>not\s+)?(?:in\s+)?(?P<currency>{CURRENCY})', text)
        if m:
            self.emit('quote', 'currency', _currency(m['currency']), not m['neg'], span)
            return True
        # Explicit entity references remain unresolved in the syntax tree. The
        # comparator requires exactly one owner activity, rather than guessing
        # a person or borrowing dates from some other matching product.
        m = _full(rf'(?:the\s+)?(?P<code>{self.product})\s+(?P<field>quantity|participants?|dates?)\s+(?:is|are)\s+(?P<neg>not\s+)?(?P<value>.+)', text)
        if m:
            field, value = m['field'], m['value']
            if field == 'quantity' and _full(COUNT, value):
                predicate, value = 'addon_quantity', _count(value)
            elif field.startswith('participant') and _full(PEOPLE, value):
                predicate, value = 'addon_people', _people(value)
            elif field.startswith('date') and _full(DATES, value):
                predicate, value = 'addon_dates', tuple(sorted(re.findall(DATE, value)))
            else:
                return False
            self.emit(ActivityReference(self.code(m['code'])), predicate, value, not m['neg'], span)
            return True
        # An explicit contextual count is not a bare monetary total.
        m = _full(rf'(?:the\s+)?(?:quantity\s*(?:is\s*)?(?P<neg>not\s+)?(?P<count>{COUNT})|(?P<count2>{COUNT})\s+in\s+total)', text)
        if m:
            self.emit(self.last_addon, 'addon_quantity', _count(m['count'] or m['count2']), not m['neg'], span)
            return True
        m = _full(rf'(?:the\s+)?participants?\s+(?:is|are)\s+(?P<neg>not\s+)?(?P<people>{PEOPLE})', text)
        if m:
            self.emit(self.last_addon, 'addon_people', _people(m['people']), not m['neg'], span)
            return True
        # Amounts have exactly one normalized role and one entire money lexeme.
        # Explicit currency names cannot fall back to an inherited currency.
        for pattern in (rf'{DETERMINER}(?P<role>{ROLE})\s*:?\s*{COPULA}{MONEY}(?P<post>\s+(?:is\s+)?(?:not\s+(?:correct|due|true)|incorrect|false|wrong))?',
                        rf'{MONEY}\s+(?:in\s+)?(?P<role>{ROLE})'):
            m = _full(pattern, text)
            if m:
                g = m.groupdict()
                value = ( _currency(g.get('currency1') or g.get('currency2') or self.facts.get('currency', '')), _cents(g.get('amount1') or g.get('amount2') or g['bare']))
                self.emit('quote', 'money:' + _role(g['role']), value, not (g.get('neg') or g.get('post')), span)
                return True
        if self.inclusion(text, span):
            return True
        return self.selection(text, span)

    def selection(self, text, span):
        # Subject extraction is shared by package and activity assignments.
        # Owner-name membership is checked only by comparison, never parsing.
        people, body, positive = (), text, True
        prefixes = (
            rf"(?P<people>{PEOPLE})'s\s+package\s+(?:is|equals)\s+(?P<neg>not\s+)?(?P<body>.+)",
            rf'(?:for\s+)?(?P<people>{PEOPLE})\s*[:,]\s*(?P<neg>not\s+)?(?P<body>.+)',
            rf'(?P<people>{PEOPLE})\s+(?:(?:does|do)\s+(?P<neg>not)\s+)?(?:has|have|gets?|selected|selects?)\s+(?:the\s+)?(?P<body>.+)',
        )
        for pattern in prefixes:
            m = _full(pattern, text)
            if m:
                people, body = _people(m['people']), m['body']
                positive = not m['neg']
                break
        # Object-fronted package/add-on, with person before the service dates.
        m = _full(rf'(?P<body>.+?)\s+for\s+(?P<people>{PEOPLE})(?P<dates>\s+on\s+{DATES})?', body)
        if m:
            if people:
                return False
            people, body = _people(m['people']), m['body'] + (m['dates'] or '')
        m = _full(rf'(?P<count>{COUNT})\s+(?P<code>{self.product})(?:\s+(?:rentals?|lessons?|add-ons?)(?:\s*/\s*(?:rentals?|lessons?|add-ons?))*)?(?:\s+on\s+(?P<dates>{DATES}))?', body)
        if m:
            people = people or self.last_people
            value = (self.code(m['code']), _count(m['count']), tuple(sorted(re.findall(DATE, m['dates'] or ''))))
            self.emit(people, 'addon' if m['dates'] else 'addon_count', value if m['dates'] else value[:2], positive, span)
            if positive:
                self.last_addon = (people, value[0], value[2])
                self.last_people = people
            return True
        m = _full(rf'(?:the\s+)?(?P<code>{self.product})(?:\s+package)?', body)
        if m:
            code = self.code(m['code'])
            # A lone unknown word is not an implicit product assertion. Explicit
            # assignment or a typed package introduces an unknown catalog entity.
            if people or m['code'] in self.aliases or body.endswith(' package'):
                if code in self.addon_codes:
                    self.emit(people if people else 'quote', 'product_for' if people else 'selected_product', code, positive, span)
                else:
                    self.emit(people, 'package', code, positive, span)
                if positive and people:
                    self.last_people = people
                return True
        return False

    def inclusion(self, text, span):
        # Scope is an entire object NP/list. Each conjunct gets its own claim.
        subject, objects, negative, predicate = None, None, False, 'includes'
        m = _full(r'(?:the\s+|your\s+)?(?:(?P<scope>stay|package|quote)\s+)?(?P<neg>does\s+not\s+)?(?P<relation>includes?|inclusions|terms)\s*:?\s+(?P<objects>.+)', text)
        if m:
            objects, negative = m['objects'], bool(m['neg'])
            subject = m['scope']
            predicate = 'term' if m['relation'] == 'terms' else 'includes'
        else:
            m = _full(r'(?P<objects>.+?)\s+(?:(?:is|are)\s+)?(?P<neg>not\s+)?(?P<relation>included|free)(?:\s+(?:in|with)\s+(?:the|your)\s+(?P<scope>stay|package|quote))?', text)
            if m:
                subject = m['scope']
                if m['relation'] == 'free':
                    subject, predicate = subject or 'quote', 'zero_price'
            if not m:
                m = _full(r'(?P<objects>.+?)\s+(?P<neg>does\s+not\s+)?comes?\s+with\s+(?:the|your)\s+(?P<scope>stay|package)', text)
                if m:
                    subject = m['scope']
            if m:
                objects, negative = m['objects'], bool(m['neg'])
        if objects is not None:
            # An inclusion's object position takes noun phrases, not clauses.
            # Recognized finite relations in a conjunct must be parsed by the
            # outer coordination rule, with their own subject and polarity.
            parts = [_term(obj) for obj in re.split(r',\s*|\s+and\s+', objects)]
            for obj in parts:
                if obj in self.aliases:
                    continue
                if not _full(r"[a-z][\w'-]*(?:\s+[a-z][\w'-]*){0,5}", obj):
                    return False
                if re.search(r"\b(?:i|we|you|he|she|they|it|is|are|was|were|has|have|had|does|do|did|will|would|can|could|must|should|not|never)\b", obj):
                    return False
                nested = Parser(obj, self.facts, ())
                if nested.atom(obj, (0, len(obj))):
                    return False
            for obj in parts:
                if predicate == 'zero_price':
                    self.emit(subject, predicate, self.code(obj), not negative, span)
                elif predicate == 'includes' and subject in {'stay', 'package'}:
                    self.emit(subject, 'scoped_includes', self.code(obj), not negative, span)
                elif predicate == 'includes' and (subject == 'quote' or obj in self.aliases):
                    self.emit('quote', 'quote_includes', self.code(obj), not negative, span)
                else:
                    self.emit(subject or 'stay', predicate, obj, not negative, span)
            return True
        m = _full(r'availability\s+(?:is\s+)?(?P<neg>not\s+)?guaranteed', text)
        if m:
            self.emit('availability', 'guaranteed', True, not m['neg'], span)
            return True
        return False

    def transaction(self, text, span):
        # Event arguments and auxiliaries determine scope. No blanket exemption
        # for sentences starting with 'after', 'when', or containing 'not'.
        events = r'booked|reserved|held|confirmed|secured|paid|received|receive|settled|charged|completed|complete|processed|successful|taken|made|went through|exists'
        entities = r'booking|reservation|payment|deposit|balance|stay|money'
        aux = r'(?:(?:have|has|had|is|are|was|were|did|been|being)\s+)*'
        neg = r"(?P<neg>not|never|neither|haven't|hasn't|isn't|aren't|wasn't)\s+(?:(?:been|being)\s+)?"
        m = _full(rf'(?:i|we)\s+{aux}(?:{neg})?(?:yet\s+)?(?P<event>{events})(?:\s+(?:or|nor)\s+(?P<event2>{events}))?\s+(?:anything|(?:your|the|a)\s+(?P<entity>{entities})|it(?:\s+for\s+you)?)(?:\s+yet)?', text)
        if not m:
            m = _full(rf'(?:your\s+|the\s+|a\s+)?(?P<entity>{entities})\s+{aux}(?:{neg})?(?:yet\s+)?(?P<event>{events})(?:\s+yet|\s+from\s+you)?', text)
        if not m:
            m = _full(rf'(?P<neg>no)\s+(?P<entity>{entities})\s+{aux}(?P<event>{events})(?:\s+yet|\s+from\s+you)?', text)
        if not m:
            m = _full(rf'(?P<neg>nothing)\s+{aux}(?P<event>{events})', text)
        if not m:
            m = _full(rf'(?:you|everything)\s+{aux}(?:{neg})?(?P<event>{events})', text)
        if m:
            g = m.groupdict()
            event = g['event']
            entity = g.get('entity') or ('payment' if event in {'paid', 'received', 'receive', 'settled', 'charged', 'processed', 'taken'} else 'booking')
            subject = 'payment' if entity in {'payment', 'deposit', 'balance', 'money'} else 'booking'
            self.emit(subject, 'transaction', event, not g.get('neg'), span)
            if g.get('event2'):
                self.emit(subject, 'transaction', g['event2'], not g.get('neg'), span)
            return True
        m = _full(rf'(?:your\s+|the\s+)?(?P<entity>booking|reservation)\s+(?:remains|is)\s+unconfirmed', text)
        if m:
            self.emit('booking', 'transaction', 'confirmed', False, span)
            return True
        m = _full(rf'(?:you\s+have\s+a|we\s+(?:already\s+)?have\s+your)\s+(?:(?P<event>confirmed|booked)\s+)?(?P<entity>{entities})', text)
        if m:
            self.emit('payment' if m['entity'] == 'payment' else 'booking', 'transaction', m['event'] or 'received', True, span)
            return True
        # A quote disclaimer has two propositions; the adjective is under 'not'.
        m = _full(r'this\s+is\s+a\s+quote,\s+not\s+a\s+(?P<event>confirmed|booked)\s+(?:booking|reservation)', text)
        if m:
            self.emit('reply', 'state', 'quote', True, span)
            self.emit('booking', 'transaction', m['event'], False, span)
            return True
        # Conditional event grammar requires a condition plus prospective modal
        # consequent. An arbitrary temporal adjunct does not suppress an event.
        m = _full(r'(?:once|if|when|after)\s+you\s+(?:have\s+)?paid,\s+(?:we|i)\s+(?:can|will)\s+confirm\s+(?:the|your)\s+(?:reservation|booking)', text)
        if m:
            self.emit('payment', 'transaction', 'paid', True, span, 'conditional')
            self.emit('booking', 'transaction', 'confirmed', True, span, 'conditional')
            return True
        m = _full(r'(?:to\s+confirm\s+your\s+booking,\s+)?please\s+pay\s+the\s+deposit', text)
        if m:
            self.emit('guest', 'instruction', 'pay_deposit', True, span, 'directive')
            return True
        return False

    def speech(self, text, span):
        if _full(r'sorry|thanks|thank you|hello|hi|unfortunately', text):
            self.emit('speaker', 'courtesy', text, True, span, 'expressive')
            return True
        m = _full(r'(?:i|we)\s+(?:have\s+)?prepared\s+(?:this|the|your)\s+quote(?:\s+for\s+you)?', text)
        if m:
            self.emit('reply', 'state', 'quote', True, span)
            return True
        m = _full(r"(?:i|we)(?: am| are)? (?:cannot|can not|could not|can't|couldn't|unable to|am unable to) (?:safely )?(?:verify|check|confirm|complete) (?:this |the |your |that )?(?:quote|availability|booking action|request|result)(?: right now| yet| at the moment| at this time)?", text)
        if m:
            self.emit('speaker', 'verification', False, True, span)
            return True
        question_patterns = (
            r'(?:which|what) (?P<field>dates|check-in and check-out dates|package|room|add-ons?|activities)(?: (?:did you want|would you like|do you prefer|work for you))?',
            r'what are (?:your |the )?(?P<field>arrival and departure dates|names of the guests)',
            r'how many (?P<field>guests|people) (?:will be staying|are coming|are travelling)',
            r'would you prefer (?:a )?(?P<field>private or shared|shared or private) room',
        )
        for pattern in question_patterns:
            m = _full(pattern, text)
            if m:
                self.emit('guest', 'question', m['field'], True, span, 'interrogative')
                return True
        polite = r'(?:please\s+|(?:could|would|can) you\s+)?'
        # Domain grammar maps surface relations to owner reason/next-step enums.
        reasons = {
            'minimum_stay': r'(?:(?:that|this|your|the) (?:stay|visit) (?:is too short|falls below the minimum (?:length|stay)|does not meet the minimum stay)|(?:the )?minimum stay (?:has not been met|is not met))',
            'beds_unavailable': r'(?:that|this|the|your) (?:room|bed|beds) (?:is|are) (?:unavailable|not available|sold out)',
            'sold_out': r'(?:the (?:entire )?property|we) (?:is|are) (?:sold out|fully booked)',
            'unknown_catalog_choice': r'(?:that|this|the) (?:choice|option|package|add-on) (?:is not available|is unknown|is not recognized)',
            'invalid_quantity': r'(?:that|this|the) quantity (?:is invalid|is too high|is not supported)',
            'incompatible_selection': r'(?:those|these|the) (?:options|selections|choices) (?:are incompatible|cannot be combined)',
        }
        steps = {
            'choose_other_dates': polite + r'(?:choose|select|change|pick) (?:the |your |other |different |new )?dates|would a longer (?:visit|stay) work',
            'choose_other_room': polite + r'(?:choose|select|pick) (?:another|a different|other) rooms?',
            'correct_request': polite + r'(?:correct|change|review|update) (?:the |your )?request',
            'wait_for_verified_result': polite + r'wait(?: for (?:a |the )?(?:verified|confirmed) result)?',
            'choose_other_option': polite + r'(?:choose|select|pick) (?:another|a different|other) (?:option|package|add-on)',
            'try_later': polite + r'try again later',
        }
        for predicate, entries in (('reason', reasons), ('next_step', steps)):
            for value, pattern in entries.items():
                if _full(pattern, text):
                    self.emit('request', predicate, value, True, span, 'directive' if predicate == 'next_step' else 'asserted')
                    return True
        return False


def parse_reply(reply, facts=None, catalog_terms=()):
    """Return a typed parse with consumed and unparsed source spans; no grading."""
    if not isinstance(reply, str):
        raise TypeError('reply must be text')
    return Parser(reply, facts, catalog_terms).parse()


def _owner_graph(facts):
    """Project authoritative data to the same relation schema as parsed claims."""
    graph, required = set(), set()
    if not isinstance(facts, dict) or not isinstance(facts['currency'], str):
        raise ValueError('missing owner facts')
    for role in ('total', 'deposit', 'remaining'):
        cents = facts[role + '_cents']
        if type(cents) is not int:
            raise ValueError('owner amounts must be integer hundredths')
        required.add(('quote', 'money:' + role, (facts['currency'].upper(), cents)))
    for role in ('check_in', 'check_out'):
        if not isinstance(facts[role], str) or not _full(DATE, facts[role]):
            raise ValueError('owner stay dates malformed')
        required.add(('stay', role, facts[role]))
    package = facts['package']
    if 'per_guest' in package:
        if not package['per_guest']:
            raise ValueError('empty package assignments')
        for p in package['per_guest']:
            required.add(((p['name'].lower(),), 'package', p['code'].lower()))
    else:
        required.add(((), 'package', package['code'].lower()))
    for a in facts['add_ons']:
        if type(a['quantity']) is not int or a['quantity'] < 0:
            raise ValueError('owner quantity malformed')
        people, dates = tuple(sorted(p.lower() for p in a['people'])), tuple(sorted(a['dates']))
        code = a['code'].lower()
        required.add((people, 'addon', (code, a['quantity'], dates)))
        graph.add((people, 'addon_count', (code, a['quantity'])))
        graph.update(((person,), 'product_for', code) for person in people)
        ref = (people, code, dates)
        graph.add((ref, 'addon_quantity', a['quantity']))
        graph.add((ref, 'addon_people', people))
        graph.add((ref, 'addon_dates', dates))
    graph.update(required)
    graph.add(('quote', 'currency', facts['currency'].upper()))
    graph.update(('quote', 'selected_product', value if predicate == 'package' else value[0])
                 for _, predicate, value in required if predicate in {'package', 'addon'})
    graph.update(('quote', 'quote_includes', value) for subject, predicate, value in tuple(graph)
                 if predicate == 'selected_product')
    for key, predicate in (('inclusions', 'includes'), ('terms', 'term')):
        for value in facts.get(key, []):
            graph.add(('stay', predicate, _term(value)))
    # Old owner terms may legitimately be rendered using 'includes'.
    graph.update(('stay', 'includes', _term(v)) for v in facts.get('terms', []))
    return graph, required


def _atoms(claim, graph=()):
    if isinstance(claim.subject, ActivityReference):
        candidates = {subject for subject, predicate, _ in graph
                      if predicate == claim.predicate and subject[1] == claim.subject.code}
        if len(candidates) != 1:
            raise ValueError('ambiguous or unknown activity reference: ' + claim.subject.code)
        return {(next(iter(candidates)), claim.predicate, claim.object)}
    if claim.predicate in {'package', 'product_for'} and claim.subject:
        return {((person,), claim.predicate, claim.object) for person in claim.subject}
    return {(claim.subject, claim.predicate, claim.object)}


def _scoped_inclusion(scope, code, facts, result):
    """Explicit scopes require inclusion evidence, never selected-product atoms."""
    # Public Staff quotes project stay inclusions from package_details. The
    # flattened facts array loses missing-row provenance: apply the same source
    # completeness rule to both scopes, rather than treating that array as an
    # independently complete statement. Legacy explicit facts retain their own
    # inclusion array contract.
    if scope == 'stay' and isinstance(result.get('quote'), dict) and isinstance(result.get('guests'), list):
        scope = 'package'
    if scope == 'stay':
        values = facts.get('inclusions')
    elif scope == 'package':
        details = result.get('package_details')
        rows = [details] if isinstance(details, dict) else details
        if not isinstance(rows, list) or any(not isinstance(row, dict) or
                not isinstance(row.get('includes'), list) for row in rows):
            return None
        package = facts['package']
        selected = {p['code'].lower() for p in package.get('per_guest', [])}
        if package.get('code'):
            selected.add(package['code'].lower())
        if any(not isinstance(row.get('code'), str) or row['code'].lower() not in selected
               for row in rows):
            return None
        by_package = {}
        for row in rows:
            package_code = row['code'].lower()
            if any(not isinstance(value, str) for value in row['includes']):
                return None
            includes = {_term(value) for value in row['includes']}
            # Accommodation-only is explicitly not a package inclusion scope.
            # Its row may be omitted, but contradictory metadata is not evidence.
            if package_code == 'package_none' and includes:
                return None
            # Repeated scopes may agree; never union conflicting descriptions.
            if package_code in by_package and by_package[package_code] != includes:
                return None
            by_package[package_code] = includes
        # A missing selected package row is unknown, unlike explicit includes: [].
        # Require complete applicable scopes before interpreting their aggregate.
        if not (selected - {'package_none'}).issubset(by_package):
            return None
        values = [value for includes in by_package.values() for value in includes]
    else:
        return None
    if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
        return None
    return code in {_term(v) for v in values}


def _zero_price(code, result):
    """Three-valued price evidence. Missing rows/prices never mean paid or free."""
    quote = result.get('quote')
    rows = quote.get('lineItems') if isinstance(quote, dict) else None
    if not isinstance(rows, list):
        return None
    # Public quote package rows use structural codes rather than catalog codes.
    # Bind those through owner guest assignments; never guess from label/note text.
    guests = result.get('guests', [])
    packages = {g['package'].lower() for g in guests
                if isinstance(g, dict) and isinstance(g.get('package'), str)}
    matches = []
    for row in rows:
        if not isinstance(row, dict):
            return None
        row_code = row.get('code')
        if row_code in {'package', 'accommodation_only'}:
            row_code = next(iter(packages)) if len(packages) == 1 else None
            if row.get('code') == 'accommodation_only' and row_code != 'package_none':
                row_code = None
        elif row_code in {'guest_package', 'guest_accommodation_only'}:
            assigned = [g['package'].lower() for g in guests if isinstance(g, dict)
                        and type(g.get('position')) is int
                        and type(row.get('guest_number')) is int
                        and g['position'] == row['guest_number']
                        and isinstance(g.get('package'), str)]
            row_code = row.get('package_code')
            if len(assigned) != 1 or assigned[0] != row_code:
                row_code = None
        if row_code == code:
            matches.append(row)
    if not matches:
        return None
    for row in matches:
        unit, total = row.get('unit_cents'), row.get('total_cents')
        if type(unit) is not int or type(total) is not int or unit < 0 or total < 0:
            return None
        if (unit == 0) != (total == 0):
            return None
        for key in ('quantity', 'days', 'people_count', 'guest_count', 'nights'):
            if key in row and (type(row[key]) is not int or row[key] <= 0):
                return None
    return all(row['total_cents'] == 0 for row in matches)


def compare_parse(parsed, outcome, facts, result):
    """Evaluate every typed relation; require positive coverage of owner essentials."""
    errors = []
    if parsed.unparsed:
        errors.append({'kind': 'unparsed', 'spans': parsed.unparsed})
    expect = outcome.get('expect')
    quote = expect in {'quote', 'mixed'}
    if quote:
        if not isinstance(result, dict) or result.get('ok') is not True or result.get('state', 'quote') != 'quote' or result.get('booked') is True or result.get('held') is True:
            return [{'kind': 'not_quote_result'}]
        graph, required = _owner_graph(facts)
    elif expect in {'refusal', 'uncertain', 'clarification'}:
        graph, required = set(), set()
        if expect != 'clarification' and (not isinstance(result, dict) or result.get('ok') is not False):
            return [{'kind': 'not_negative_result'}]
        if expect == 'refusal':
            reason = result.get('reason') or result.get('code')
            if result.get('classification') != outcome.get('classification') or reason not in outcome.get('allowed_reasons', []) or ('next_step' in outcome and result.get('next_step') != outcome['next_step']):
                return [{'kind': 'refusal_binding'}]
            required.add(('request', 'reason', reason))
            if result.get('next_step'):
                required.add(('request', 'next_step', result['next_step']))
            graph.update(required)
        elif expect == 'uncertain':
            required.add(('speaker', 'verification', False))
            graph.update(required)
            graph.add(('request', 'next_step', result.get('next_step')))
            graph.add(('request', 'next_step', 'try_later'))
    else:
        return [{'kind': 'unknown_outcome'}]
    seen, question = set(), False
    for claim in parsed.propositions:
        pred = claim.predicate
        good = False
        if pred == 'courtesy':
            good = True
        elif pred == 'transaction':
            good = not claim.polarity or (quote and claim.modality == 'conditional')
        elif pred == 'instruction':
            good = quote and claim.object == 'pay_deposit'
        elif pred == 'state':
            good = quote and claim.object == 'quote'
        elif pred == 'question':
            good = expect == 'clarification'
            question = question or good
        elif pred == 'guaranteed':
            good = not claim.polarity
        elif pred == 'zero_price':
            price = _zero_price(claim.object, result) if quote else None
            good = price is not None and price == claim.polarity
            if good and claim.subject != 'quote':
                good = _scoped_inclusion(claim.subject, claim.object, facts, result) is True
        elif pred == 'scoped_includes':
            included = _scoped_inclusion(claim.subject, claim.object, facts, result) if quote else None
            good = included is not None and included == claim.polarity
        elif pred == 'includes':
            # Bare non-catalog inclusion clauses share the stay evidence owner.
            # Preserve supported term rendering, but never certify absence from
            # an incomplete projected inclusion set.
            known = _scoped_inclusion('stay', claim.object, facts, result) if quote else None
            atoms = _atoms(claim, graph)
            good = known is not None and (atoms.issubset(graph) if claim.polarity else not (atoms & graph))
        else:
            atoms = _atoms(claim, graph)
            # A negative conjunction asserts that NONE of its component facts
            # holds, not merely that at least one component is absent.
            good = atoms.issubset(graph) if claim.polarity else not (atoms & graph)
            if not quote and pred not in {'reason', 'next_step', 'verification'}:
                good = False
            if pred.startswith('addon_') and claim.subject is None:
                good = False  # unresolved reference is not evidence of a negative
            if claim.polarity and good:
                seen.update(atoms)
        if not good:
            errors.append({'kind': 'unsupported_or_contradictory', 'claim': claim})
    if required - seen:
        errors.append({'kind': 'missing_required', 'claims': sorted(required - seen, key=repr)})
    if expect == 'clarification' and not question:
        errors.append({'kind': 'missing_question'})
    return errors


def diagnose_reply(reply, outcome, facts, result, catalog_terms=()):
    """JSON-serializable coverage, proposition and comparison diagnostics."""
    try:
        if not isinstance(reply, str) or not reply.strip() or not isinstance(outcome, dict):
            raise ValueError('empty reply or malformed outcome')
        parsed = parse_reply(reply, facts, catalog_terms)
        errors = compare_parse(parsed, outcome, facts, result)
        if outcome.get('expect') == 'clarification' and '?' not in reply:
            errors.append({'kind': 'missing_question_mark'})
        return {'truth': not errors, 'propositions': [p._asdict() for p in parsed.propositions],
                'consumed': parsed.consumed, 'unparsed': parsed.unparsed, 'errors': errors}
    except (KeyError, TypeError, ValueError, IndexError, AttributeError, ArithmeticError) as error:
        return {'truth': False, 'propositions': [], 'consumed': [], 'unparsed': [],
                'errors': [{'kind': 'malformed', 'detail': str(error)}]}


def reply_truth(reply, outcome, facts, result, catalog_terms=()):
    return diagnose_reply(reply, outcome, facts, result, catalog_terms)['truth']


# Compatibility diagnostic hooks used by the independent probe. The decision
# path above never chains these filters; it parses once and compares every claim.
def _component(text, facts, predicates, catalog_terms=()):
    try:
        parsed = parse_reply(text, facts, catalog_terms)
        graph, required = _owner_graph(facts)
        claims = [p for p in parsed.propositions if p.predicate in predicates]
        seen = set()
        for p in claims:
            atoms = _atoms(p, graph)
            if (p.polarity and not atoms.issubset(graph)) or (not p.polarity and atoms & graph):
                return False
            if p.polarity:
                seen.update(atoms)
        return {a for a in required if a[1] in predicates}.issubset(seen)
    except (KeyError, TypeError, ValueError, AttributeError, ArithmeticError):
        return False


def _money_truth(text, facts):
    return _component(text, facts, {'money:total', 'money:deposit', 'money:remaining', 'currency'})


def _products_truth(text, facts, catalog_terms=()):
    return _component(text, facts, {'package', 'addon', 'addon_count', 'addon_quantity', 'addon_people', 'addon_dates', 'selected_product', 'product_for'}, catalog_terms)


def _dates_truth(text, facts):
    return _component(text, facts, {'check_in', 'check_out'})


def _terms_truth(text, facts, catalog_terms=()):
    parsed = parse_reply(text, facts, catalog_terms)
    return not any(p.predicate == 'guaranteed' and p.polarity for p in parsed.propositions) and _component(text, facts, {'includes', 'term'}, catalog_terms)


def _transactions_truth(text):
    return not any(p.predicate == 'transaction' and p.polarity and p.modality == 'asserted'
                   for p in parse_reply(text).propositions)
