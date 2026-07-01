# db.py — database module with shared state

_connection_pool = None
_connection_count = 0

class Config:
    def __init__(self, host, port=5432):
        self.host = host
        self.port = port

class PooledConnection(Config):
    def __init__(self, host, pool_size=10):
        super().__init__(host)
        self.pool_size = pool_size

def connect_db(config):
    global _connection_count
    _connection_count += 1
    return f"db://{config.host}:{config.port}"

def execute_query(db, sql):
    result = _cache_lookup(sql)
    if result is None:
        result = _do_query(db, sql)
    return result

def _cache_lookup(sql):
    return None

def _do_query(db, sql):
    return f"result of {sql} on {db}"
