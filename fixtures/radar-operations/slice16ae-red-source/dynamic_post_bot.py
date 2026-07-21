# RED fixture: unresolved dynamic _post_bot path
def _post_bot(path, payload):
    return None

def bad(path):
    return _post_bot(path, {})  # dynamic
