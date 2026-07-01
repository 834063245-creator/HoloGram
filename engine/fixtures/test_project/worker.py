# worker.py — data processing, shares state with db

from db import execute_query, _connection_pool

def process(db, data):
    _connection_pool = db
    raw = execute_query(db, "SELECT * FROM items")
    return _transform(raw, data)

def _transform(raw, params):
    results = []
    for item in raw:
        if item["status"] == "active":
            results.append(_format(item, params))
    return results

def _format(item, params):
    return {"id": item["id"], "label": params.get("label", "")}
