# RED fixture: source-mutation introducing unmatched staff_http site
def _post_bot(path, payload):
    raise RuntimeError("fixture only")

def evil_tool():
    return _post_bot("/evil-unregistered-mutate", {})

def check_availability():
    return _post_bot("/availability-check", {})
