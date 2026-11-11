import hashlib
import json

MAX_REVISION = 2**63 - 1
CANONICAL_FORMAT = 'manifest-json/v1'


def revision(value):
    if type(value) is not int or not 1 <= value <= MAX_REVISION:
        raise ValueError('revision must be an integer in 1..2^63-1')
    return value


def identifier(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise ValueError('identifier must be a nonempty string of at most 512 characters')
    if any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        raise ValueError('identifier contains control characters')
    try:
        value.encode('utf-8')
    except UnicodeError as exc:
        raise ValueError('identifier must be valid Unicode') from exc
    return value


def canonical_json(value):
    def validate(item):
        if item is None or isinstance(item, bool):
            return
        if isinstance(item, str):
            try:
                item.encode('utf-8')
            except UnicodeError as exc:
                raise ValueError('manifest contains invalid Unicode') from exc
        elif type(item) is int:
            if abs(item) > 2**53 - 1:
                raise ValueError('large manifest integers must be decimal strings')
        elif isinstance(item, list):
            for entry in item:
                validate(entry)
        elif isinstance(item, dict):
            for key, entry in item.items():
                if not isinstance(key, str) or not key.isascii():
                    raise ValueError('manifest keys must be ASCII strings')
                validate(key)
                validate(entry)
        else:
            raise ValueError('manifest values must be JSON primitives; decimals use strings')
    validate(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def content_hash(value):
    return hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()
