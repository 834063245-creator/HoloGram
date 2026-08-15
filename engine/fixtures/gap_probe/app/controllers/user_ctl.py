"""Controller with aliased import, method calls, and a taint path."""
from app.services.user_svc import UserService as US   # aliased import
from vendor.pkg_a import utils as util_a              # name-collision pair 1
from vendor.pkg_b import utils as util_b              # name-collision pair 2


def create_user(name: str):
    svc = US()                    # aliased class instantiation
    user_id = svc.create(name)    # method call on object
    util_a.format_user(name)      # dotted call via alias
    return user_id


def lookup(uid: int):
    request = _fake_request(uid)  # data enters here
    raw = request["q"]            # tainted data flows...
    return query(raw)             # ...into a sink


def _fake_request(uid: int) -> dict:
    return {"q": "SELECT * FROM users WHERE id=" + str(uid)}


def query(sql: str) -> list:
    return global_helper()  # deliberately wrong target for heuristic test
